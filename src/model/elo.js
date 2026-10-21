// Elo prior for the goals model (Phase 2).
//
//   m_att_i =  ba * (E_i - Ebar) / 400
//   m_def_i = -bd * (E_i - Ebar) / 400          (def = defensive WEAKNESS)
//
// (ba, bd) are ridge-regression slopes of the fitted attack / defence of a
// first-pass fit (Phase 1 prior) on the standardised Elo, over the teams of
// the league that have at least 25 matches. Teams without an Elo rating keep
// the Phase 1 prior (promoted offsets or 0). Pure functions, no I/O.

import { DEFAULTS } from './dc.js';

export const ELO_SCALE = 400;
export const MIN_MATCHES = 25; // a team needs this many matches to enter the regression
export const MIN_SAMPLE = 8; // ... and the regression needs this many teams
export const MIN_COVERAGE = 0.7; // share of the league's teams that must have an Elo rating
export const RIDGE = 0.05; // lambda = RIDGE * Sxx (about 5 % shrinkage of the slope)
export const MAX_SLOPE = 1.5;

/**
 * Elo rating for every team key of the league.
 * eloByKey: Map key -> rating (all clubs of the country, keys from the resolver).
 * A team that is not found by key gets one fuzzy attempt against the Elo names
 * (accepted only when unique, see names.js).
 * Returns { map: Map teamKey -> rating, fuzzy: [[teamKey, eloKey]] }.
 */
export function eloForTeams({ teamKeys, eloByKey, resolver = null }) {
  const map = new Map();
  const fuzzy = [];
  const universe = new Set(eloByKey.keys());
  for (const k of teamKeys) {
    if (eloByKey.has(k)) {
      map.set(k, eloByKey.get(k));
      continue;
    }
    if (!resolver) continue;
    const m = resolver.match(k, universe);
    if (m.key && eloByKey.has(m.key)) {
      map.set(k, eloByKey.get(m.key));
      fuzzy.push([k, m.key]);
    }
  }
  return { map, fuzzy };
}

/** Unweighted number of matches per team in the fitted sample. */
function matchCounts(model) {
  const n = new Float64Array(model.teams.length);
  for (const r of model.rows) {
    n[r.h] += 1;
    n[r.a] += 1;
  }
  return n;
}

/** Centred ridge slope of y on z: Sxy / (Sxx * (1 + ridge)). */
export function ridgeSlope(z, y, ridge = RIDGE) {
  const n = z.length;
  let mz = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mz += z[i];
    my += y[i];
  }
  mz /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (z[i] - mz) ** 2;
    sxy += (z[i] - mz) * (y[i] - my);
  }
  if (!(sxx > 0)) return 0;
  return sxy / (sxx * (1 + ridge));
}

/**
 * @param {object} p
 * @param {object} p.model        first-pass fit (fitGoals result, Phase 1 prior)
 * @param {Map<string, number>} p.elo   team key -> Elo rating (eloForTeams().map)
 * @param {Set<string>} p.active  teams that are currently in the league
 * @param {Set<string>} [p.promoted]    used only for teams without Elo
 * @returns {{ ok: boolean, reason?: string, ba?: number, bd?: number, ebar?: number,
 *             n?: number, coverage: number, priorMeans?: {mAtt: Float64Array, mDef: Float64Array} }}
 */
export function fitEloPrior({ model, elo, active, promoted = new Set(), minMatches = MIN_MATCHES, ridge = RIDGE }) {
  const activeKeys = [...active].filter((k) => model.index.has(k));
  const rated = activeKeys.filter((k) => elo.has(k));
  const coverage = activeKeys.length > 0 ? rated.length / activeKeys.length : 0;
  if (rated.length < MIN_SAMPLE || coverage < MIN_COVERAGE) {
    return { ok: false, coverage, reason: `Elo for ${rated.length} of ${activeKeys.length} teams (need ${Math.round(MIN_COVERAGE * 100)} %)` };
  }

  const counts = matchCounts(model);
  const ebar = rated.reduce((s, k) => s + elo.get(k), 0) / rated.length;
  const sample = rated.filter((k) => counts[model.index.get(k)] >= minMatches);
  if (sample.length < MIN_SAMPLE) {
    return { ok: false, coverage, reason: `only ${sample.length} teams with ${minMatches}+ matches` };
  }
  const z = sample.map((k) => (elo.get(k) - ebar) / ELO_SCALE);
  const att = sample.map((k) => model.att[model.index.get(k)]);
  const dfn = sample.map((k) => model.def[model.index.get(k)]);
  const clamp = (v) => Math.max(0, Math.min(MAX_SLOPE, v));
  const ba = clamp(ridgeSlope(z, att, ridge));
  const bd = clamp(-ridgeSlope(z, dfn, ridge)); // def falls as Elo rises

  const n = model.teams.length;
  const mAtt = new Float64Array(n);
  const mDef = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = model.teams[i];
    if (elo.has(k)) {
      const zi = (elo.get(k) - ebar) / ELO_SCALE;
      mAtt[i] = ba * zi;
      mDef[i] = -bd * zi;
    } else if (promoted.has(k)) {
      mAtt[i] = DEFAULTS.promotedAtt;
      mDef[i] = DEFAULTS.promotedDef;
    }
  }
  return { ok: true, ba, bd, ebar, n: sample.length, coverage, priorMeans: { mAtt, mDef } };
}
