// tune.json: what the weekly tuning job hands to the daily refresh.
//
//   {
//     "schema": 1, "generatedAt": ISO,
//     "leagues": { "PL": { "params": { xi, sigma, om, elo }, "source": "tuned"|"default", ... } },
//     "calibration": { "adopted": { x12: {tau, d}|null, ou25: {a, b}|null, btts: {a, b}|null }, ... } | null
//   }
//
// The refresh never trusts the file blindly: every value must be one of the
// grid values the tuning job searches (or a bounded calibration number),
// otherwise that part is ignored and the Phase 2 defaults are used.

import { readJsonIfExists } from './cache.js';
import { PHASE2_DEFAULTS } from '../model/goalsFit.js';

/** The tuning grid of the spec (coordinate search per league). */
export const GRID = Object.freeze({
  xi: Object.freeze([0.001, 0.0015, 0.0019, 0.0025, 0.0035]),
  sigma: Object.freeze([0.15, 0.2, 0.25, 0.3, 0.4]),
  om: Object.freeze([0.4, 0.6, 0.8, 1]),
});

export const STALE_TUNE_DAYS = 21;

const onGrid = (list, v) => typeof v === 'number' && list.some((g) => Math.abs(g - v) < 1e-12);

/** { xi, sigma, om, elo } if every value is legal, otherwise null. */
export function sanitizeParams(p) {
  if (!p || typeof p !== 'object') return null;
  if (!onGrid(GRID.xi, p.xi) || !onGrid(GRID.sigma, p.sigma) || !onGrid(GRID.om, p.om) || typeof p.elo !== 'boolean') return null;
  return { xi: p.xi, sigma: p.sigma, om: p.om, elo: p.elo };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Calibration maps with bounded numbers; an illegal map becomes null (= identity). */
export function sanitizeCalibration(c) {
  if (!c || typeof c !== 'object') return null;
  const x12 = c.x12 && finite(c.x12.tau) && finite(c.x12.d) && c.x12.tau >= 0.3 && c.x12.tau <= 3 && c.x12.d >= Math.exp(-1) - 1e-9 && c.x12.d <= Math.E + 1e-9 ? { tau: c.x12.tau, d: c.x12.d } : null;
  const bin = (m) => (m && finite(m.a) && finite(m.b) && Math.abs(m.a) <= 3 && m.b >= 0.2 && m.b <= 3 ? { a: m.a, b: m.b } : null);
  const out = { x12, ou25: bin(c.ou25), btts: bin(c.btts) };
  return out.x12 || out.ou25 || out.btts ? out : null;
}

/**
 * Read and check tune.json.
 * Returns { found, generatedAt, ageDays, leagues: Map(code -> {params, source}), calibration, warnings }.
 */
export function readTune(file, now) {
  const out = { found: false, generatedAt: null, ageDays: null, leagues: new Map(), calibration: null, warnings: [] };
  const json = readJsonIfExists(file);
  if (json === null) return out;
  const warn = (code, message) => out.warnings.push({ code, message });
  if (json?.schema !== 1 || typeof json.leagues !== 'object' || json.leagues === null) {
    warn('tune-invalid', 'tune.json: μη αναγνωρίσιμη μορφή - χρησιμοποιούνται οι προεπιλεγμένες παράμετροι.');
    return out;
  }
  out.found = true;
  out.generatedAt = typeof json.generatedAt === 'string' ? json.generatedAt : null;
  const t = Date.parse(out.generatedAt);
  if (Number.isFinite(t)) {
    out.ageDays = (now.getTime() - t) / 86400000;
    if (out.ageDays > STALE_TUNE_DAYS) {
      warn('tune-stale', `tune.json: η τελευταία εβδομαδιαία βελτιστοποίηση έγινε πριν από ${Math.floor(out.ageDays)} μέρες (έλεγξε το workflow "Weekly tune").`);
    }
  }
  for (const [code, entry] of Object.entries(json.leagues)) {
    const params = sanitizeParams(entry?.params);
    if (!params) {
      warn('tune-league-invalid', `tune.json: μη έγκυρες παράμετροι για ${code} - χρησιμοποιούνται οι προεπιλεγμένες.`);
      continue;
    }
    out.leagues.set(code, { params, source: entry.source === 'tuned' ? 'tuned' : 'default' });
  }
  if (json.calibration?.adopted) {
    out.calibration = sanitizeCalibration(json.calibration.adopted);
    if (!out.calibration && (json.calibration.adopted.x12 || json.calibration.adopted.ou25 || json.calibration.adopted.btts)) {
      warn('tune-calibration-invalid', 'tune.json: μη έγκυρη βαθμονόμηση πιθανοτήτων - δεν εφαρμόζεται.');
    }
  }
  return out;
}

/** The parameters of one league: tuned values or the Phase 2 defaults. */
export function paramsFor(tune, code) {
  const e = tune?.leagues?.get(code);
  return e ? { params: e.params, source: e.source } : { params: { ...PHASE2_DEFAULTS }, source: 'default' };
}
