// The scorecard: every probability the page shows is written down BEFORE the match; once the real result is known
// it is scored. Nothing here changes a forecast: it only measures them (RPS, hit rate, calibration, corners / cards error).
//
// Storage: cache entry "predictions" on the data branch = { schema, open: { key: prediction }, done: [scored] }.
// Output: scorecard.json (read by the page, tab "Αξιοπιστία").

import { calibrationBins, logLoss1x2, rps } from '../model/metrics.js';

export const SCORECARD_SCHEMA = 1;
export const KEEP_DAYS = 400; // scored matches older than this are dropped
export const WAIT_DAYS = 10; // a started match whose result never shows up is dropped after this
export const MIN_FOR_SKILL = 20; // fewer scored matches: numbers are shown but no skill is claimed
const DAY_MS = 86400000;
const CUPS = new Set(['CL', 'EL']);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const dayOf = (iso) => Math.floor(Date.parse(iso) / DAY_MS);

/** The forecast of one published match, as it will be judged later. null when the match has no usable 1X2. */
export function predictionOf(code, m, now) {
  const o = m?.goals?.oneX2;
  if (!o || ![o.home, o.draw, o.away].every(finite) || typeof m.kickoff !== 'string' || !Number.isFinite(Date.parse(m.kickoff))) return null;
  const ou = Array.isArray(m.goals.totals) ? m.goals.totals.find((t) => t.line === 2.5) : null;
  return {
    k: `${code}:${m.id}`,
    code,
    id: m.id,
    kickoff: m.kickoff,
    home: m.home,
    away: m.away,
    names: [m.homeName, m.awayName],
    p: [o.home, o.draw, o.away],
    ou25: ou && finite(ou.over) ? ou.over : null,
    btts: finite(m.goals.btts?.yes) ? m.goals.btts.yes : null,
    cm: finite(m.corners?.mean?.total) ? m.corners.mean.total : null,
    kd: finite(m.cards?.mean?.total) ? m.cards.mean.total : null,
    est: Boolean(m.corners?.estimate || m.cards?.estimate),
    made: now.toISOString(),
  };
}

/**
 * @param {object|null} prev            the stored predictions of the previous run
 * @param {{code:string, json:object, stale?:boolean}[]} built  leagues built in this run
 * @param {{ domestic: Map<string, object[]>, cups: Map<string, object[]> }} results
 *        domestic: league code -> CSV rows ({t, home, away, x, y, hc, ac, hy, ay, hr, ar}) with resolved team keys
 *        cups: cup code -> finished matches ({id, kickoff, home:{name}, away:{name}, x, y})
 * @param {{key:(name:string)=>string}} resolver
 */
export function updateScorecard({ prev, built, results, resolver, now }) {
  const store = { schema: SCORECARD_SCHEMA, open: { ...(prev?.schema === SCORECARD_SCHEMA ? prev.open : {}) }, done: prev?.schema === SCORECARD_SCHEMA && Array.isArray(prev.done) ? [...prev.done] : [] };
  // 1. forecasts of matches that have not started: the latest one before kick-off is the one that counts
  for (const l of built) {
    if (l.json?.stale) continue;
    for (const m of l.json?.matches ?? []) {
      if (!(Date.parse(m.kickoff) > now.getTime())) continue;
      const p = predictionOf(l.code, m, now);
      if (p) store.open[p.k] = p;
    }
  }
  // 2. started matches: score them when the result is there
  const doneKeys = new Set(store.done.map((d) => d.k));
  let lost = 0;
  for (const [k, p] of Object.entries(store.open)) {
    if (Date.parse(p.kickoff) > now.getTime()) continue;
    const r = findResult(p, results, resolver);
    if (r) {
      if (!doneKeys.has(k)) store.done.push(scoreOne(p, r));
      delete store.open[k];
    } else if (now.getTime() - Date.parse(p.kickoff) > WAIT_DAYS * DAY_MS) {
      delete store.open[k];
      lost++;
    }
  }
  store.done = store.done.filter((d) => now.getTime() - Date.parse(d.kickoff) <= KEEP_DAYS * DAY_MS);
  return { store, scorecard: buildScorecard(store, { now, lost }) };
}

function findResult(p, results, resolver) {
  if (CUPS.has(p.code)) {
    const list = results.cups.get(p.code) ?? [];
    const byId = list.find((r) => r.id === p.id && Number.isInteger(r.x) && Number.isInteger(r.y));
    if (byId) return { x: byId.x, y: byId.y };
    const d = dayOf(p.kickoff);
    const hit = list.find((r) => Number.isInteger(r.x) && Number.isInteger(r.y) && Math.abs(dayOf(r.kickoff) - d) <= 1 && resolver.key(r.home?.name) === p.home && resolver.key(r.away?.name) === p.away);
    return hit ? { x: hit.x, y: hit.y } : null;
  }
  const d = dayOf(p.kickoff);
  const hit = (results.domestic.get(p.code) ?? []).find((r) => r.home === p.home && r.away === p.away && Math.abs(r.t - d) <= 1 && Number.isInteger(r.x) && Number.isInteger(r.y));
  return hit ? { x: hit.x, y: hit.y, hc: hit.hc, ac: hit.ac, hy: hit.hy, ay: hit.ay, hr: hit.hr, ar: hit.ar } : null;
}

function scoreOne(p, r) {
  const count = (...v) => (v.every((x) => Number.isInteger(x)) ? v.reduce((s, x) => s + x, 0) : null);
  return {
    k: p.k,
    code: p.code,
    kickoff: p.kickoff,
    names: p.names,
    p: p.p,
    o: r.x > r.y ? 0 : r.x === r.y ? 1 : 2,
    goals: r.x + r.y,
    ou25: p.ou25,
    btts: p.btts,
    both: r.x > 0 && r.y > 0 ? 1 : 0,
    cm: p.cm,
    ca: count(r.hc, r.ac),
    kd: p.kd,
    ka: count(r.hy, r.ay, r.hr, r.ar),
    est: p.est,
  };
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** Numbers of one group of scored matches. */
export function statsOf(rows) {
  const n = rows.length;
  if (n === 0) return null;
  const freq = [0, 0, 0];
  for (const r of rows) freq[r.o]++;
  const base = freq.map((c) => c / n);
  const rpsModel = mean(rows.map((r) => rps(r.p, r.o)));
  const rpsBase = mean(rows.map((r) => rps(base, r.o)));
  const hit = mean(rows.map((r) => (r.p.indexOf(Math.max(...r.p)) === r.o ? 1 : 0)));
  const binary = (pick, truth) => {
    const sel = rows.filter((r) => finite(pick(r)));
    if (sel.length === 0) return null;
    const b = mean(sel.map((r) => truth(r)));
    return { n: sel.length, brier: mean(sel.map((r) => (pick(r) - truth(r)) ** 2)), brierBase: mean(sel.map((r) => (b - truth(r)) ** 2)) };
  };
  const preds = [];
  const outs = [];
  for (const r of rows) for (let k = 0; k < 3; k++) {
    preds.push(r.p[k]);
    outs.push(r.o === k ? 1 : 0);
  }
  const count = (modelKey, actualKey) => {
    const sel = rows.filter((r) => finite(r[modelKey]) && Number.isInteger(r[actualKey]));
    if (sel.length === 0) return null;
    return { n: sel.length, mae: mean(sel.map((r) => Math.abs(r[modelKey] - r[actualKey]))), bias: mean(sel.map((r) => r[modelKey] - r[actualKey])), meanActual: mean(sel.map((r) => r[actualKey])) };
  };
  return {
    n,
    hit,
    rps: rpsModel,
    rpsBase,
    skill: n >= MIN_FOR_SKILL && rpsBase > 0 ? 1 - rpsModel / rpsBase : null,
    logLoss: mean(rows.map((r) => logLoss1x2(r.p, r.o))),
    outcomes: { home: base[0], draw: base[1], away: base[2] },
    ou25: binary((r) => r.ou25, (r) => (r.goals >= 3 ? 1 : 0)),
    btts: binary((r) => r.btts, (r) => r.both),
    calibration: calibrationBins(preds, outs, 10),
    corners: count('cm', 'ca'),
    cards: count('kd', 'ka'),
  };
}

export function buildScorecard(store, { now, lost = 0 }) {
  const done = store.done;
  const codes = [...new Set(done.map((d) => d.code))];
  const leagues = {};
  for (const c of codes) leagues[c] = statsOf(done.filter((d) => d.code === c));
  const dates = done.map((d) => d.kickoff.slice(0, 10)).sort();
  return {
    schema: SCORECARD_SCHEMA,
    generatedAt: now.toISOString(),
    since: dates[0] ?? null,
    last: dates.at(-1) ?? null,
    scored: done.length,
    pending: Object.keys(store.open).length,
    lost,
    all: statsOf(done),
    domestic: statsOf(done.filter((d) => !CUPS.has(d.code))),
    leagues,
  };
}
