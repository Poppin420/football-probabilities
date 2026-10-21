// Corners and cards: fitting wrappers around the NegBin two-sided GLM,
// the red-card shrinkage model and the referee factor.

import { timeWeight } from './dc.js';
import { fitTwoSided } from './glm.js';
import { fitNegBinTwoSided, nbPmfArray } from './negbin.js';
import { poissonPmfArray } from './poisson.js';

export const SIGMA_COUNTS = 0.2; // ridge for corners (sigma_C) and yellows (sigma_Y)
export const MAX_TEAM_COUNT = 40; // support 0..40 per team

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Fit a count market (corners or yellows).
 * matches: [{ t, home, away, ...fields }] with team keys;
 * homeField / awayField name the count columns, e.g. 'hc' / 'ac'.
 * Returns null when there is too little data.
 */
export function fitCountMarket({
  matches,
  teams,
  homeField,
  awayField,
  tNow,
  xi,
  sigma = SIGMA_COUNTS,
  minMatches = 150,
  forcePoisson = false, // the plain Poisson baseline of the back-test
}) {
  const index = new Map();
  teams.forEach((k, i) => index.set(k, i));
  const rows = [];
  for (const m of matches) {
    if (!(m.t < tNow)) continue;
    if (!isCount(m[homeField]) || !isCount(m[awayField])) continue;
    const h = index.get(m.home);
    const a = index.get(m.away);
    if (h === undefined || a === undefined) continue;
    rows.push({ h, a, x: m[homeField], y: m[awayField], w: timeWeight(m.t, tNow, xi) });
  }
  if (rows.length < minMatches) return null;

  const res = forcePoisson
    ? { fit: fitTwoSided({ rows, nTeams: teams.length, sigma, family: 'poisson' }), family: 'poisson', r: Infinity, rRaw: Infinity }
    : fitNegBinTwoSided({ rows, nTeams: teams.length, sigma });
  const { fit, family, r } = res;
  const diag = diagnostics(rows, fit, family, r);
  const effN = new Float64Array(teams.length);
  for (const row of rows) {
    effN[row.h] += row.w;
    effN[row.a] += row.w;
  }
  return {
    teams: teams.slice(),
    index,
    fit,
    family,
    r,
    rRaw: res.rRaw,
    nUsed: rows.length,
    effN,
    ...diag,
  };
}

/** Means for a fixture. fixtureFactor multiplies both means (referee factor). */
export function predictCountMeans(model, home, away, factor = 1) {
  const h = model.index.get(home);
  const a = model.index.get(away);
  if (h === undefined || a === undefined) throw new Error(`Unknown team: ${home} / ${away}`);
  const { c, eta, att, def } = model.fit;
  return {
    mHome: factor * Math.exp(c + eta + att[h] + def[a]),
    mAway: factor * Math.exp(c + att[a] + def[h]),
  };
}

/** pmfs (0..40) for home and away counts at the given means. */
export function countPmfs(model, mHome, mAway) {
  const r = model.family === 'negbin' ? model.r : Infinity;
  return {
    home: nbPmfArray(mHome, r, MAX_TEAM_COUNT),
    away: nbPmfArray(mAway, r, MAX_TEAM_COUNT),
  };
}

/**
 * Diagnostics for the independence assumption. corrRaw is the weighted
 * correlation of home vs away counts; corrResid is the weighted correlation
 * of Pearson residuals (the one that matters once team strength is modelled).
 */
function diagnostics(rows, fit, family, r) {
  const zx = [];
  const zy = [];
  const rawX = [];
  const rawY = [];
  const ws = [];
  for (const row of rows) {
    const m1 = Math.exp(fit.c + fit.eta + fit.att[row.h] + fit.def[row.a]);
    const m2 = Math.exp(fit.c + fit.att[row.a] + fit.def[row.h]);
    const v1 = family === 'negbin' ? m1 + (m1 * m1) / r : m1;
    const v2 = family === 'negbin' ? m2 + (m2 * m2) / r : m2;
    zx.push((row.x - m1) / Math.sqrt(v1));
    zy.push((row.y - m2) / Math.sqrt(v2));
    rawX.push(row.x);
    rawY.push(row.y);
    ws.push(row.w);
  }
  const corrResid = weightedCorr(zx, zy, ws);
  const corrRaw = weightedCorr(rawX, rawY, ws);
  return { corrRaw, corrResid, warnCorr: Math.abs(corrResid) > 0.1 };
}

export function weightedCorr(x, y, w) {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < x.length; i++) {
    sw += w[i];
    mx += w[i] * x[i];
    my += w[i] * y[i];
  }
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += w[i] * dx * dx;
    syy += w[i] * dy * dy;
    sxy += w[i] * dx * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// ---------------------------------------------------------------------------
// Red cards: Poisson, league rate times a shrunken team multiplier.

/**
 * rbar = league red cards per team-match; team rate per match is
 * rbar * (R_i + 30 rbar) / (n_i + 30) / rbar = (R_i + 30 rbar) / (n_i + 30).
 * R_i and n_i use the same time weights as the other models.
 */
export function fitReds({ matches, teams, tNow, xi, prior = 30 }) {
  const index = new Map();
  teams.forEach((k, i) => index.set(k, i));
  const R = new Float64Array(teams.length);
  const N = new Float64Array(teams.length);
  let sReds = 0;
  let sW = 0;
  let used = 0;
  for (const m of matches) {
    if (!(m.t < tNow)) continue;
    if (!isCount(m.hr) || !isCount(m.ar)) continue;
    const h = index.get(m.home);
    const a = index.get(m.away);
    if (h === undefined || a === undefined) continue;
    const w = timeWeight(m.t, tNow, xi);
    R[h] += w * m.hr;
    R[a] += w * m.ar;
    N[h] += w;
    N[a] += w;
    sReds += w * (m.hr + m.ar);
    sW += 2 * w;
    used++;
  }
  if (used < 150) return null;
  const rbar = sReds / sW;
  const mult = new Float64Array(teams.length);
  for (let i = 0; i < teams.length; i++) mult[i] = (R[i] + prior * rbar) / (N[i] + prior) / rbar;
  return { index, rbar, mult, nUsed: used };
}

export function predictReds(model, home, away) {
  const h = model.index.get(home);
  const a = model.index.get(away);
  if (h === undefined || a === undefined) throw new Error(`Unknown team: ${home} / ${away}`);
  return { home: model.rbar * model.mult[h], away: model.rbar * model.mult[a] };
}

export function redPmf(mean) {
  return poissonPmfArray(mean, 6);
}

// ---------------------------------------------------------------------------
// Referee factor f = (S + 10 cbar) / ((n + 10) cbar), only when n >= 5.

/** Lower-case word list of a referee name: no accents, no dots, no ", Country" suffix (API-Football style). */
export function refereeTokens(name) {
  if (!name || typeof name !== 'string') return [];
  return name
    .split(',')[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function refereeKey(name) {
  const tokens = refereeTokens(name);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0][0]} ${tokens[tokens.length - 1]}`;
}

/** Per-referee card totals from the history (unweighted counts). */
export function refereeStats(matches, tNow) {
  const stats = new Map();
  let sCards = 0;
  let nMatches = 0;
  for (const m of matches) {
    if (!(m.t < tNow)) continue;
    if (![m.hy, m.ay, m.hr, m.ar].every(isCount)) continue;
    const cards = m.hy + m.ay + m.hr + m.ar;
    sCards += cards;
    nMatches++;
    const key = refereeKey(m.referee);
    if (!key) continue;
    const s = stats.get(key) || { S: 0, n: 0, tokens: refereeTokens(m.referee) };
    s.S += cards;
    s.n += 1;
    stats.set(key, s);
  }
  const cbar = nMatches > 0 ? sCards / nMatches : NaN;
  return { stats, cbar, nMatches };
}

/**
 * Can a name written in the history (football-data.co.uk: "M Oliver", "Gil Manzano", "Maresca") be the same person
 * as another spelling ("Michael Oliver", "Jesus Gil Manzano", "Fabio Maresca")? The words of the history name
 * (without a one-letter initial) must be the LAST words of the other name, and a given initial must agree.
 */
export function refereeNamesCompatible(otherTokens, historyTokens) {
  if (otherTokens.length === 0 || historyTokens.length === 0) return false;
  const initial = historyTokens[0].length === 1 ? historyTokens[0] : null;
  const words = historyTokens.filter((t) => t.length > 1);
  if (words.length === 0 || words.length > otherTokens.length) return false;
  const tail = otherTokens.slice(otherTokens.length - words.length);
  if (!words.every((w, i) => w === tail[i])) return false;
  return initial === null || initial === otherTokens[0][0];
}

/**
 * The history entry of a referee: the exact "initial + surname" key first, then a looser match that accepts
 * only ONE possible referee of the history (two candidates = no match, never a guess).
 */
export function refereeEntry(refStats, refereeName) {
  const key = refereeKey(refereeName);
  if (!key || !refStats) return null;
  const direct = refStats.stats.get(key);
  if (direct) return direct;
  const tokens = refereeTokens(refereeName);
  let found = null;
  for (const s of refStats.stats.values()) {
    if (!refereeNamesCompatible(tokens, s.tokens)) continue;
    if (found) return null;
    found = s;
  }
  return found;
}

export function refereeFactor(refStats, refereeName, minMatches = 5, prior = 10) {
  if (!refStats || !Number.isFinite(refStats.cbar)) return 1;
  const s = refereeEntry(refStats, refereeName);
  if (!s || s.n < minMatches) return 1;
  return (s.S + prior * refStats.cbar) / ((s.n + prior) * refStats.cbar);
}

/** Display facts about a referee for the UI: how many matches of the history, and the factor (null below 5 matches). */
export function refereeSummary(refStats, refereeName, minMatches = 5, prior = 10) {
  if (!refereeName || typeof refereeName !== 'string') return null;
  const name = refereeName.split(',')[0].trim();
  if (!name) return null;
  const s = refStats ? refereeEntry(refStats, refereeName) : null;
  const factor = s && s.n >= minMatches && Number.isFinite(refStats.cbar) ? (s.S + prior * refStats.cbar) / ((s.n + prior) * refStats.cbar) : null;
  return { name, matches: s ? s.n : 0, factor };
}
