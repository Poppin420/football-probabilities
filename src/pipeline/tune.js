// Weekly tuning + back-test (Phase 2).
//
// For every league:
//   1. rolling origins, one per week, over the last 2 completed seasons; the
//      model is trained STRICTLY on matches before the origin (Elo as of the
//      origin) and predicts the matches of the next 7 days;
//   2. coordinate search of xi, sigma, om (and Elo on/off) with the objective
//      "log-loss 1X2 + log-loss Over/Under 2.5 + log-loss BTTS", choosing by the
//      1-standard-error rule (the value closest to the default among those that
//      are not clearly worse than the best), see coordinateSearch();
//   3. the chosen setting is evaluated like production (mean of the 100
//      Bayesian-bootstrap matrices) and compared with the league base rates and
//      a plain Poisson model; RPS, log-loss, Brier, reliability bins and the
//      calibration slope are stored per market, early season vs the rest;
//   4. corners and yellow cards: NegBin log-score against a Poisson baseline;
//   5. (Phase 3) the half-time markets of the same final back-test: half-time result, HT/FT combinations and
//      first-half Over 0.5 / 1.5 against the base rates of the training sample.
// Then an optional calibration layer (pooled over the leagues) is kept only if
// it improves the nested out-of-sample log-loss.
// 6. (Phase 3) The Elo-only model of the Champions League cannot be back-tested on the cup itself, so its formula
//    is tested on the domestic matches of all leagues together (eloOnlyBacktest.js) and compared with the pooled
//    base rates and with the league model on the same matches. Non-fatal: it never changes the exit code.
// Output: tune.json (read by the daily refresh) and report.json (UI tab "Αξιοπιστία").

import fs from 'node:fs';
import path from 'node:path';
import { RATE, domesticLeagues, currentTime, eloPoolLeagues, isoDate, seasonCode, seasonStartYear } from '../config.js';
import { fetchSeasonCsv } from '../sources/footballDataCoUk.js';
import { fetchEloSnapshot } from '../sources/clubElo.js';
import { createResolver } from '../sources/names.js';
import { loadAliases } from '../sources/aliases.js';
import { sleep } from '../sources/http.js';
import { PHASE1_PARAMS, PHASE2_DEFAULTS } from '../model/goalsFit.js';
import { runBacktest } from '../model/backtest.js';
import { runCountBacktest } from '../model/countBacktest.js';
import { DEFAULT_K } from '../model/bootstrap.js';
import { calibrationReport, halfSkill, objectiveSeries, pairedSe, summarize, summarizeHalf } from '../model/metrics.js';
import { adoptedCalibration, fitCalibration, nestedEvaluate } from '../model/calibrate.js';
import { ageHours, copyTree, createCache, readJsonIfExists, writeJson } from './cache.js';
import { GRID } from './tuneFile.js';
import { loadEloSnapshots, makeEloAt, monthStarts } from './eloSnapshots.js';
import { buildOwnElo } from './ownEloData.js';
import { BIG_GAP, matchKey, runEloOnlyBacktest, skipReasonText, summarizeFits } from './eloOnlyBacktest.js';
import { EVAL_SEASONS, SEASONS_BACK, keepCacheName, oldestSeasonNeeded } from './retention.js';

export const MIN_SKILL = 0.08; // the model must beat the base rates by this much in RPS (spec)
export const MIN_EVAL_MATCHES = 300; // fewer test matches than this: the league is not judged
export const MIN_HALF_MATCHES = 200; // fewer test matches with a half-time score than this: no half-time numbers
export const MIN_ELO_ONLY_MATCHES = 300; // fewer scored matches than this: the Elo-only model is not judged
const MIN_BIG_GAP_MATCHES = 100; // fewer matches with a large rating gap than this: no separate numbers for them
export { monthStarts };
const COMPLETED_CSV_TTL_H = 24 * 30;
const MEAN = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

// ------------------------------------------------------------------ search --

const paramKey = (p) => `${p.xi}|${p.sigma}|${p.om}|${p.elo}`;

/**
 * 1-standard-error rule. cands: [{ value, mean, series }] in grid order.
 * Candidates whose mean objective is within one paired standard error of the
 * best are "as good as the best"; among them the one closest to the default
 * value wins (ties: the lower objective). So a value away from the default is
 * only chosen when the default is clearly worse.
 */
export function chooseOneSe(cands, defaultValue, seFactor = 1) {
  const best = cands.reduce((a, b) => (b.mean < a.mean ? b : a));
  const defIdx = cands.findIndex((c) => c.value === defaultValue);
  const near = cands.filter((c) => c === best || c.mean - best.mean <= seFactor * pairedSe(c.series, best.series));
  near.sort((a, b) => Math.abs(cands.indexOf(a) - defIdx) - Math.abs(cands.indexOf(b) - defIdx) || a.mean - b.mean);
  return near[0];
}

/**
 * Coordinate search (xi, sigma, om, then Elo on/off), at most `sweeps` passes.
 * evaluate(params) -> { mean, series } (series = per-match objective, same order for every call).
 */
export function coordinateSearch({ evaluate, defaults = PHASE2_DEFAULTS, grid = GRID, withElo = true, sweeps = 2, seFactor = 1 }) {
  const coords = [
    ['xi', grid.xi],
    ['sigma', grid.sigma],
    ['om', grid.om],
  ];
  if (withElo) coords.push(['elo', [true, false]]);
  let cur = { xi: defaults.xi, sigma: defaults.sigma, om: defaults.om, elo: defaults.elo };
  const trail = [];
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let changed = false;
    for (const [name, values] of coords) {
      const cands = values.map((v) => {
        const params = { ...cur, [name]: v };
        const ev = evaluate(params);
        return { value: v, params, mean: ev.mean, series: ev.series };
      });
      const pick = chooseOneSe(cands, defaults[name], seFactor);
      trail.push({ sweep: sweep + 1, coordinate: name, chosen: pick.value, objective: pick.mean, best: Math.min(...cands.map((c) => c.mean)) });
      if (pick.value !== cur[name]) {
        cur = pick.params;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const base = evaluate({ ...defaults });
  const tuned = evaluate(cur);
  return {
    params: cur,
    objective: { default: base.mean, tuned: tuned.mean },
    gain: base.mean - tuned.mean, // positive = the tuned setting is better
    gainSe: pairedSe(base.series, tuned.series),
    trail,
  };
}

// -------------------------------------------------------------------- data --

/** All matches of a league for the given season start years, with team keys and season tags. */
export async function loadHistory({ league, years, cache, now, resolver, logger, sleepFn, fetchCsv, state }) {
  const rows = [];
  const missing = [];
  const completedFrom = seasonStartYear(now);
  for (const y of years) {
    const code = seasonCode(y);
    const name = `csv-${league.div}-${code}`;
    const cached = cache.peek(name);
    let list = null;
    if (cached && y < completedFrom && ageHours(cached.fetchedAt, now) < COMPLETED_CSV_TTL_H) {
      list = cached.rows;
      cache.put(name, cached);
    } else {
      try {
        if (state.downloads++ > 0) await sleepFn(RATE.csvPauseMs);
        const res = await fetchCsv(league.div, code);
        if (res.missing) {
          if (cached) {
            list = cached.rows;
            cache.put(name, cached);
          } else missing.push(code);
        } else {
          list = res.rows;
          cache.put(name, { fetchedAt: now.toISOString(), rows: res.rows });
        }
      } catch (err) {
        if (!cached) throw new Error(`CSV ${league.div} ${code}: ${err.message}`);
        logger.error(`[${league.code}] CSV ${code} unavailable, using the cache from ${cached.fetchedAt}: ${err.message}`);
        list = cached.rows;
        cache.put(name, cached);
      }
    }
    for (const r of list || []) rows.push({ ...r, season: y, home: resolver.key(r.home), away: resolver.key(r.away) });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, missing };
}

// ------------------------------------------------------------- one league --

const round = (x, d = 5) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function metricsOf(s) {
  return {
    n: s.n,
    x12: { rps: round(s.x12.rps), logLoss: round(s.x12.logLoss), brier: round(s.x12.brier) },
    ou25: { logLoss: round(s.ou25.logLoss), brier: round(s.ou25.brier) },
    btts: { logLoss: round(s.btts.logLoss), brier: round(s.btts.brier) },
    objective: round(s.objective),
  };
}

/** 1 - model / reference, per market (positive = better than the reference). */
function skillOf(model, ref) {
  const sk = (a, b) => (b > 0 ? round(1 - a / b) : null);
  return {
    rps: sk(model.x12.rps, ref.x12.rps),
    logLoss1x2: sk(model.x12.logLoss, ref.x12.logLoss),
    ou25: sk(model.ou25.logLoss, ref.ou25.logLoss),
    btts: sk(model.btts.logLoss, ref.btts.logLoss),
  };
}

function rangeWidths(records) {
  const w = { home: [], over25: [], btts: [] };
  for (const r of records) {
    if (!r.ranges) continue;
    w.home.push(r.ranges.oneX2.home[1] - r.ranges.oneX2.home[0]);
    w.over25.push(r.ranges.over25[1] - r.ranges.over25[0]);
    w.btts.push(r.ranges.btts[1] - r.ranges.btts[0]);
  }
  return { home: round(MEAN(w.home)), over25: round(MEAN(w.over25)), btts: round(MEAN(w.btts)) };
}

function binsOut(cal) {
  return {
    slope: round(cal.slope, 3),
    intercept: round(cal.intercept, 3),
    bins: cal.bins.map((b) => ({ lo: round(b.lo, 2), hi: round(b.hi, 2), n: b.n, p: round(b.p, 4), f: round(b.f, 4) })),
  };
}

/** Half-time scores of the final back-test (see metrics.js summarizeHalf), rounded for the report. */
function halfOut(s) {
  const pick = (m) => ({
    ht: { rps: round(m.ht.rps), logLoss: round(m.ht.logLoss) },
    htft: { logLoss: round(m.htft.logLoss) },
    over05: { logLoss: round(m.over05.logLoss) },
    over15: { logLoss: round(m.over15.logLoss) },
  });
  const sk = halfSkill(s);
  return { n: s.n, model: pick(s.model), base: pick(s.base), skill: Object.fromEntries(Object.entries(sk).map(([k, v]) => [k, round(v)])) };
}

/**
 * Non-fatal warning when the half-time result is worse than the base rates of the league (the 8 % limit of the
 * spec applies to the full-time result only, so this never changes the exit code).
 */
export function halfFlags(htft) {
  const sk = htft?.skill?.htRps;
  if (typeof sk !== 'number' || !Number.isFinite(sk) || sk >= 0) return [];
  return [
    {
      code: 'htft-below-base',
      message: `Οι πιθανότητες του ημιχρόνου είναι χειρότερες από τις βασικές συχνότητες (${(sk * 100).toFixed(1).replace('.', ',')}% στο RPS του ημιχρόνου): διάβασε τα με επιφύλαξη.`,
    },
  ];
}

const statsOut = (s, d) => (s ? { mean: round(s.mean, d), min: round(s.min, d), max: round(s.max, d) } : null);

/**
 * Non-fatal warning when the Elo-only model is no better than the base rates (the 8 % limit of the spec applies
 * to the league model only, so this never changes the exit code).
 */
export function eloOnlyFlags(eloOnly) {
  const sk = eloOnly?.skill?.vsBase?.rps;
  if (typeof sk !== 'number' || !Number.isFinite(sk) || sk >= 0) return [];
  return [
    {
      code: 'elo-only-below-base',
      message: `Το μοντέλο μόνο-Elo (Champions League) είναι χειρότερο από τις βασικές συχνότητες σε εγχώριους αγώνες (${(sk * 100).toFixed(1).replace('.', ',')}% στο RPS): διάβασε τις πιθανότητες του Champions League με μεγάλη επιφύλαξη.`,
    },
  ];
}

/**
 * The weekly numbers of the Elo-only model (see eloOnlyBacktest.js) for report.json.
 * proxy: the result of runEloOnlyBacktest; fullRecords: the records of the league back-tests (same matches, scored
 * with the full model); leagues: codes of the leagues in the pooled sample.
 * Returns { skipped } when there are too few scored matches to judge anything.
 */
export function eloOnlyReport({ proxy, fullRecords = [], leagues = [] }) {
  const all = proxy.records;
  if (all.length < MIN_ELO_ONLY_MATCHES) {
    const reasons = Object.entries(proxy.skipped.reasons).sort((a, b) => b[1] - a[1]);
    return {
      skipped: `βαθμολογήθηκαν μόνο ${all.length} αγώνες (χρειάζονται ${MIN_ELO_ONLY_MATCHES}): ${proxy.skipped.origins} από ${proxy.origins} εβδομαδιαίες αφετηρίες παραλείφθηκαν${reasons.length ? ` - ${skipReasonText(reasons[0][0])}` : ''}, ${proxy.unrated} αγώνες δεν είχαν βαθμολογία Elo και για τις δύο ομάδες`,
    };
  }

  // The league model scored the same matches: compare on exactly those (when they are nearly all of them).
  const fullByKey = new Map(fullRecords.map((r) => [matchKey(r.t, r.home, r.away), r]));
  const joined = all.filter((r) => fullByKey.has(r.key));
  const compare = joined.length >= 0.9 * all.length && joined.length >= MIN_ELO_ONLY_MATCHES;
  const set = compare ? joined : all;

  const model = summarize(set);
  const pooledBase = summarize(set, (r) => r.base);
  const out = {
    leagues,
    n: set.length,
    scored: all.length,
    origins: proxy.origins,
    skippedOrigins: proxy.skipped.origins,
    unrated: proxy.unrated,
    fit: (() => {
      const f = summarizeFits(proxy.fits);
      return { origins: f.origins, kappa: statsOut(f.kappa, 3), eta: statsOut(f.eta, 3), c: statsOut(f.c, 3), rho: statsOut(f.rho, 3), rows: statsOut(f.rows, 0) };
    })(),
    metrics: { model: metricsOf(model), base: metricsOf(pooledBase) },
    skill: { vsBase: skillOf(model, pooledBase) },
    leagueModel: null,
    bigGap: null,
    flags: [],
  };

  if (compare) {
    const full = set.map((r) => fullByKey.get(r.key));
    const leagueModel = summarize(full);
    out.leagueModel = { metrics: metricsOf(leagueModel), base: metricsOf(summarize(full, (r) => r.base)) };
    out.skill.vsLeagueModel = skillOf(model, leagueModel);
  }

  // Cup matches are often between clubs far apart in rating: how does the model do when the gap is large?
  const big = set.filter((r) => Math.abs(r.dE) >= BIG_GAP);
  if (big.length >= MIN_BIG_GAP_MATCHES) {
    const m = summarize(big);
    const b = summarize(big, (r) => r.base);
    out.bigGap = { threshold: BIG_GAP, n: big.length, share: round(big.length / set.length, 3), metrics: { model: metricsOf(m), base: metricsOf(b) }, skill: { vsBase: skillOf(m, b) } };
  }

  out.flags = eloOnlyFlags(out);
  return out;
}

function countOut(r) {
  if (!r) return null;
  return {
    n: r.n,
    origins: r.origins,
    negbin: round(r.negbin, 4),
    poisson: round(r.poisson, 4),
    gain: round(r.gain, 4),
    gainSe: round(r.gainSe, 4),
    negbinOrigins: r.families.negbin,
    meanRatio: round(r.meanRatio, 3),
  };
}

/**
 * Tune and evaluate one league.
 * Returns { tune, report, records } or throws.
 */
export function tuneLeague({ league, matches, from, to, eloAt, resolver, bootstrapK, logger }) {
  const evals = new Map();
  const evaluate = (params) => {
    const k = paramKey(params);
    if (!evals.has(k)) {
      const bt = runBacktest({ matches, from, to, params, eloAt: params.elo ? eloAt : null, resolver });
      const series = objectiveSeries(bt.records);
      evals.set(k, { mean: MEAN(series), series, n: bt.records.length, diag: bt.diag });
    }
    return evals.get(k);
  };
  const first = evaluate({ ...PHASE2_DEFAULTS });
  if (first.n < MIN_EVAL_MATCHES) {
    return { skipped: `only ${first.n} test matches (need ${MIN_EVAL_MATCHES})` };
  }
  const search = coordinateSearch({ evaluate, withElo: Boolean(eloAt) });
  const tuned = search.params;
  logger.log(`[${league.code}] tuned xi ${tuned.xi} sigma ${tuned.sigma} om ${tuned.om} elo ${tuned.elo} | gain ${search.gain.toFixed(5)} ± ${search.gainSe.toFixed(5)} (${evals.size} back-tests)`);

  // Final evaluation: like production (bootstrap mean), plus the references.
  const final = runBacktest({ matches, from, to, params: tuned, eloAt: tuned.elo ? eloAt : null, resolver, baseline: true, bootstrapK, seedTag: league.code, htft: true });
  const poisson = runBacktest({ matches, from, to, params: { xi: 0, sigma: PHASE2_DEFAULTS.sigma, om: 1, elo: false }, rho: 0, resolver });
  const phase1 = runBacktest({ matches, from, to, params: PHASE1_PARAMS, resolver });
  const records = final.records;
  if (poisson.records.length !== records.length || phase1.records.length !== records.length) {
    throw new Error('internal error: the reference back-tests cover different matches');
  }

  const model = summarize(records);
  const base = summarize(records, (r) => r.base);
  const early = records.filter((r) => r.early);
  const rest = records.filter((r) => !r.early);
  const period = (list) => (list.length >= 30 ? { ...metricsOf(summarize(list)), base: metricsOf(summarize(list, (r) => r.base)), skill: skillOf(summarize(list), summarize(list, (r) => r.base)) } : null);

  const cal = calibrationReport(records);
  const skill = skillOf(model, base);
  const flags = [];
  if (skill.rps === null || skill.rps < MIN_SKILL) {
    flags.push({
      code: 'skill-below-8pct',
      message: `Το μοντέλο ξεπερνά τις βασικές συχνότητες κατά ${skill.rps === null ? '–' : (skill.rps * 100).toFixed(1).replace('.', ',')}% στο RPS (όριο ${MIN_SKILL * 100}%): πιθανό σφάλμα, χρειάζεται έλεγχος.`,
    });
  }
  if (tuned.elo && eloAt && final.diag.eloFits === 0) {
    flags.push({ code: 'elo-never-applied', message: 'Το Elo prior δεν εφαρμόστηκε σε κανένα σημείο του backtest (λείπουν ή δεν αντιστοιχίστηκαν ομάδες του ClubElo).' });
  }

  // Half-time markets: only matches with a valid half-time score count (older files may lack the columns).
  const half = summarizeHalf(records);
  const htft = half.n >= MIN_HALF_MATCHES ? halfOut(half) : null;
  flags.push(...halfFlags(htft));

  const fields = { corners: { home: 'hc', away: 'ac' }, yellows: { home: 'hy', away: 'ay' } };
  const counts = {};
  for (const [name, f] of Object.entries(fields)) {
    counts[name] = countOut(runCountBacktest({ matches, from, to, fields: f, xi: tuned.xi }));
  }

  const tune = {
    params: tuned,
    source: paramKey(tuned) === paramKey(PHASE2_DEFAULTS) ? 'default' : 'tuned',
    matches: records.length,
    objective: { default: round(search.objective.default), tuned: round(search.objective.tuned) },
    gain: round(search.gain),
    gainSe: round(search.gainSe),
    eloEvaluated: Boolean(eloAt),
  };
  const report = {
    name: league.name,
    matches: records.length,
    origins: final.origins,
    params: tuned,
    tuning: {
      source: tune.source,
      defaults: { ...PHASE2_DEFAULTS },
      objective: tune.objective,
      gain: tune.gain,
      gainSe: tune.gainSe,
      backtests: evals.size,
      eloEvaluated: tune.eloEvaluated,
      trail: search.trail.map((t) => ({ ...t, objective: round(t.objective), best: round(t.best) })),
    },
    metrics: { model: metricsOf(model), base: metricsOf(base), poisson: metricsOf(summarize(poisson.records)), phase1: metricsOf(summarize(phase1.records)) },
    skill: { vsBase: skill, vsPoisson: skillOf(model, summarize(poisson.records)), vsPhase1: skillOf(model, summarize(phase1.records)) },
    calibration: { home: binsOut(cal.home), draw: binsOut(cal.draw), away: binsOut(cal.away), ou25: binsOut(cal.ou25), btts: binsOut(cal.btts) },
    season: { early: period(early), rest: period(rest) },
    counts,
    htft,
    ranges: { meanWidth: rangeWidths(records) },
    elo: {
      applied: final.diag.eloFits,
      origins: final.origins,
      coverage: round(MEAN(final.diag.eloCoverage), 3),
      ba: round(MEAN(final.diag.ba), 3),
      bd: round(MEAN(final.diag.bd), 3),
    },
    xg: { proxyBias: round(MEAN(final.diag.proxyBias), 3) },
    flags,
  };
  return { tune, report, records };
}

// ------------------------------------------------- ClubElo as the alternative --

/**
 * The same Elo-only proxy back-test with ClubElo's ratings, when ClubElo answers (information only: the model uses ONE
 * source). Returns { status: 'unavailable' } when it does not.
 */
async function clubEloAlternative({ eloOnly, domestic, leagues, from, to, resolver, cache, now, logger, sleepFn, fetchElo, deadline, probeMs, eloOnlyMinRows, warnings }) {
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(probeMs / 1000)} s`)), probeMs);
      timer.unref?.();
    });
    try {
      await Promise.race([fetchElo(isoDate(now)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.log(`[ClubElo] not available (${String(err.message).slice(0, 120)}): no comparison this week`);
    return { status: 'unavailable', reason: String(err.message).slice(0, 160) };
  }
  try {
    const dates = monthStarts(from, to);
    const countries = new Set(leagues.map((l) => l.eloCountry).filter(Boolean));
    const res = await loadEloSnapshots({ dates, countries, cache, now, logger, sleepFn, fetchElo, deadline });
    if (res.snaps.size === 0) return { status: 'unavailable', reason: 'no snapshots' };
    const alt = domestic.map((d) => {
      const teamKeys = new Set();
      for (const m of d.history) {
        teamKeys.add(m.home);
        teamKeys.add(m.away);
      }
      const lg = leagues.find((l) => l.code === d.code);
      return { ...d, eloAt: makeEloAt({ snaps: res.snaps, country: lg.eloCountry, resolver, teamKeys }) };
    });
    const proxy = runEloOnlyBacktest({ domestic: alt, from, to, ...(eloOnlyMinRows ? { minRows: eloOnlyMinRows } : {}) });
    const rep = eloOnlyReport({ proxy, fullRecords: [], leagues: alt.map((l) => l.code) });
    if (rep.skipped) return { status: 'skipped', reason: rep.skipped };
    const ownRps = eloOnly.metrics?.model?.x12?.rps;
    const altRps = rep.metrics?.model?.x12?.rps;
    const margin = 0.0005;
    const better = !Number.isFinite(ownRps) || !Number.isFinite(altRps) ? null : altRps < ownRps - margin ? 'clubelo' : ownRps < altRps - margin ? 'own' : 'equal';
    if (better === 'clubelo') {
      warnings.push({ code: 'clubelo-better', message: `Το ClubElo ξαναλειτουργεί και στη δοκιμή μόνο-Elo βγαίνει καλύτερο από το δικό μας Elo (RPS ${altRps} έναντι ${ownRps}). Αν θες να το χρησιμοποιήσεις, βάλε τη μεταβλητή ELO_SOURCE = clubelo (δες SETUP.md).` });
    }
    return { status: 'ok', n: rep.n, rps: altRps, ownRps, skillVsBase: rep.skill?.vsBase?.rps ?? null, better };
  } catch (err) {
    logger.error(`[ClubElo comparison] ${err.message}`);
    return { status: 'error', reason: String(err.message).slice(0, 160) };
  }
}

// ------------------------------------------------------------ orchestrator --

/**
 * @returns {Promise<{ exitCode:number, publish:boolean, report?:object, tune?:object, warnings:object[] }>}
 */
export async function runTune({
  prevDir,
  outDir,
  aliasesPath,
  now = currentTime(),
  logger = console,
  only = null,
  budgetMs = 45 * 60 * 1000,
  bootstrapK = DEFAULT_K,
  sleepFn = sleep,
  fetchCsv = fetchSeasonCsv,
  fetchElo = fetchEloSnapshot,
  eloSource = process.env.ELO_SOURCE === 'clubelo' ? 'clubelo' : 'own', // 'own' = Elo computed from the results (default), 'clubelo' = downloaded
  eloProbeMs = 30 * 1000, // time allowed for the ClubElo availability probe (own Elo: the cross-check runs only when ClubElo answers)
  eloOnlyMinRows = null, // tests only: the smallest pooled sample of the Elo-only regression (production value when null)
} = {}) {
  const deadline = Date.now() + budgetMs;
  const warnings = [];
  fs.mkdirSync(outDir, { recursive: true });

  const prevIndex = readJsonIfExists(path.join(prevDir, 'index.json'));
  if (!prevIndex) {
    logger.log('Δεν υπάρχουν δεδομένα στο branch "data" ακόμη: τρέξε πρώτα το workflow "Refresh data". Δεν δημοσιεύεται τίποτα.');
    return { exitCode: 0, publish: false, warnings };
  }

  // The new commit replaces the branch: start from the previous content, minus the
  // two files rewritten here and the cache entries that left the retention window.
  copyTree(prevDir, outDir, (rel) => {
    if (rel === 'tune.json' || rel === 'report.json') return true;
    const m = /^cache[\\/](.+)\.json\.gz$/.exec(rel);
    return Boolean(m && /^(csv-|elo-\d)/.test(m[1]) && !keepCacheName(m[1], now));
  });
  const cache = createCache(prevDir, outDir);
  const loadedAliases = loadAliases(aliasesPath);
  warnings.push(...loadedAliases.warnings);
  const resolver = createResolver(loadedAliases.aliases);
  const prevTune = readJsonIfExists(path.join(prevDir, 'tune.json'));
  const prevReport = readJsonIfExists(path.join(prevDir, 'report.json'));
  // A league that cannot be evaluated this week keeps last week's numbers, marked stale.
  const keepPrevious = (code, name, reason) => {
    const old = prevReport?.leagues?.[code];
    report.leagues[code] = old?.metrics
      ? { ...old, stale: true, staleReason: reason, staleSince: old.staleSince || prevReport.generatedAt }
      : { name, error: reason };
    if (prevTune?.leagues?.[code]) tune.leagues[code] = prevTune.leagues[code];
  };

  const leagues = domesticLeagues(only); // the Champions League has no domestic history to back-test
  const cur = seasonStartYear(now);
  const years = [];
  for (let y = oldestSeasonNeeded(now); y < cur; y++) years.push(y);
  const evalYears = years.slice(-EVAL_SEASONS);
  logger.log(`Tuning run ${now.toISOString()} | seasons ${years.map(seasonCode).join(', ')} | evaluated ${evalYears.map(seasonCode).join(', ')} | leagues ${leagues.map((l) => l.code).join(', ')}`);

  // Data -------------------------------------------------------------------------
  const csvState = { downloads: 0 };
  const data = new Map();
  for (const league of leagues) {
    try {
      const { rows, missing } = await loadHistory({ league, years, cache, now, resolver, logger, sleepFn, fetchCsv, state: csvState });
      const inWindow = rows.filter((m) => evalYears.includes(m.season));
      if (inWindow.length === 0) throw new Error('no matches of the evaluated seasons');
      data.set(league.code, { rows, from: Math.min(...inWindow.map((m) => m.t)), to: Math.max(...inWindow.map((m) => m.t)) + 1 });
      if (missing.length > 0) warnings.push({ league: league.code, code: 'csv-missing', message: `Tuning ${league.code}: λείπουν σεζόν (${missing.join(', ')}) - λιγότερα δεδομένα εκπαίδευσης.` });
    } catch (err) {
      logger.error(`[${league.code}] ${err.message}`);
      warnings.push({ league: league.code, code: 'tune-data-failed', message: `Tuning ${league.code}: ${err.message}` });
    }
  }

  // Elo snapshots (monthly): our own, computed from the results, or ClubElo's --------------
  const own = eloSource === 'own';
  let snaps = new Map();
  const eloStats = { source: eloSource, wanted: 0, have: 0, failed: 0 };
  let ownInfo = null;
  const dataRange = () => {
    const ds = [...data.values()];
    return { from: Math.min(...ds.map((d) => d.from)), to: Math.max(...ds.map((d) => d.to)) };
  };
  if (data.size > 0 && own) {
    const { from } = dataRange();
    const leagueRows = [];
    for (const league of eloPoolLeagues()) {
      let rows = data.get(league.code)?.rows;
      if (!rows) {
        try {
          rows = (await loadHistory({ league, years, cache, now, resolver, logger, sleepFn, fetchCsv, state: csvState })).rows;
        } catch (err) {
          logger.error(`[own Elo] ${league.code}: ${err.message}`);
          continue;
        }
      }
      leagueRows.push({ league, rows });
    }
    // finished Champions League matches: read from the cache the daily refresh keeps (no download here)
    const cupParts = [];
    for (let y = cur - 1; y >= cur - 1 - EVAL_SEASONS - SEASONS_BACK; y--) {
      const c = cache.peek(`cup-results-CL-${y}`);
      if (c?.results) {
        cache.put(`cup-results-CL-${y}`, c);
        cupParts.push({ season: String(y), results: c.results });
      }
    }
    const built = buildOwnElo({ leagueRows, cupParts, resolver, now, fromDay: from });
    snaps = built.snaps;
    ownInfo = built.info;
    Object.assign(eloStats, { wanted: built.info.snapshots, have: snaps.size, failed: 0, matches: built.info.matches, clubs: built.info.clubs, cupMatches: built.info.cupMatches });
    if (built.info.cupMatches === 0) warnings.push({ code: 'own-elo-no-cup', message: 'Δικό μας Elo: δεν υπάρχουν αποτελέσματα Champions League στο cache - οι χώρες δεν συνδέονται μεταξύ τους (το Elo prior κάθε λίγκας δεν επηρεάζεται).' });
  } else if (data.size > 0) {
    const { from, to } = dataRange();
    const dates = monthStarts(from, to);
    const countries = new Set(leagues.map((l) => l.eloCountry).filter(Boolean));
    const res = await loadEloSnapshots({ dates, countries, cache, now, logger, sleepFn, fetchElo, deadline });
    snaps = res.snaps;
    Object.assign(eloStats, { wanted: dates.length, have: snaps.size, failed: res.failed });
    if (snaps.size === 0) warnings.push({ code: 'elo-unavailable', message: 'ClubElo: δεν υπάρχουν στιγμιότυπα - δεν αξιολογείται το Elo prior (μένει η προεπιλογή).' });
    else if (res.failed > 0) warnings.push({ code: 'elo-partial', message: `ClubElo: ${res.failed} από ${dates.length} στιγμιότυπα λείπουν - το Elo prior αξιολογήθηκε με λιγότερα σημεία.` });
  }

  // Leagues -------------------------------------------------------------------------
  const tune = { schema: 1, generatedAt: now.toISOString(), leagues: {}, calibration: null };
  const report = {
    schema: 1,
    generatedAt: now.toISOString(),
    window: { seasons: evalYears.map((y) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`), stepDays: 7, horizonDays: 7, seasonsBack: SEASONS_BACK, bootstrapK },
    criteria: { minSkill: MIN_SKILL },
    elo: eloStats,
    leagues: {},
    pooled: null,
    calibrationLayer: null,
    warnings,
  };
  const allRecords = [];
  for (const league of leagues) {
    const d = data.get(league.code);
    if (!d) {
      keepPrevious(league.code, league.name, 'δεν κατέβηκαν τα δεδομένα');
      continue;
    }
    if (Date.now() > deadline) {
      warnings.push({ league: league.code, code: 'tune-time', message: `Tuning ${league.code}: ξεπεράστηκε ο χρόνος - η λίγκα παραλείπεται αυτή την εβδομάδα.` });
      keepPrevious(league.code, league.name, 'ξεπεράστηκε ο χρόνος');
      continue;
    }
    try {
      const eloAt = snaps.size > 0 && league.eloCountry ? makeEloAt({ snaps, country: league.eloCountry, resolver }) : null;
      const res = tuneLeague({ league, matches: d.rows, from: d.from, to: d.to, eloAt, resolver, bootstrapK, logger });
      if (res.skipped) {
        warnings.push({ league: league.code, code: 'tune-skipped', message: `Tuning ${league.code}: ${res.skipped}.` });
        keepPrevious(league.code, league.name, res.skipped);
        continue;
      }
      tune.leagues[league.code] = res.tune;
      report.leagues[league.code] = res.report;
      allRecords.push(...res.records);
    } catch (err) {
      logger.error(`[${league.code}] ${err.stack || err.message}`);
      warnings.push({ league: league.code, code: 'tune-failed', message: `Tuning ${league.code}: ${err.message}` });
      keepPrevious(league.code, league.name, err.message);
    }
  }

  // Elo-only model of the Champions League, tested on the domestic matches (Phase 3) ------------
  // A week that cannot evaluate it keeps last week's numbers, marked stale (like a league).
  const keepPreviousEloOnly = (reason) => {
    const old = prevReport?.eloOnly;
    if (old?.metrics) report.eloOnly = { ...old, stale: true, staleReason: reason, staleSince: old.staleSince || prevReport.generatedAt };
  };
  if (snaps.size === 0) {
    keepPreviousEloOnly(own ? 'δεν υπάρχουν στιγμιότυπα Elo' : 'δεν υπάρχουν στιγμιότυπα ClubElo');
  } else if (data.size > 0) {
    let eloOnly;
    try {
      const domestic = [];
      for (const league of leagues) {
        const d = data.get(league.code);
        if (!d || !league.eloCountry) continue;
        // the same fuzzy attempt for the CSV spellings as the daily refresh makes
        const teamKeys = new Set();
        for (const m of d.rows) {
          teamKeys.add(m.home);
          teamKeys.add(m.away);
        }
        domestic.push({ code: league.code, history: d.rows, eloAt: makeEloAt({ snaps, country: league.eloCountry, resolver, teamKeys }), from: d.from, to: d.to });
      }
      const proxy = runEloOnlyBacktest({
        domestic,
        from: Math.min(...domestic.map((l) => l.from)),
        to: Math.max(...domestic.map((l) => l.to)),
        ...(eloOnlyMinRows ? { minRows: eloOnlyMinRows } : {}),
      });
      eloOnly = eloOnlyReport({ proxy, fullRecords: allRecords, leagues: domestic.map((l) => l.code) });
      if (own && !eloOnly.skipped) {
        eloOnly.source = 'own';
        eloOnly.alt = await clubEloAlternative({ eloOnly, domestic, leagues, from: Math.min(...domestic.map((l) => l.from)), to: Math.max(...domestic.map((l) => l.to)), resolver, cache, now, logger, sleepFn, fetchElo, deadline, probeMs: eloProbeMs, eloOnlyMinRows, warnings });
      }
    } catch (err) {
      logger.error(`[Elo-only] ${err.stack || err.message}`);
      eloOnly = { skipped: err.message };
    }
    if (eloOnly.skipped) {
      warnings.push({ code: 'elo-only-skipped', message: `Δοκιμή μοντέλου μόνο-Elo (Champions League): δεν αξιολογήθηκε - ${eloOnly.skipped}.` });
      keepPreviousEloOnly(eloOnly.skipped);
    } else {
      report.eloOnly = eloOnly;
      if (eloOnly.flags.length > 0) warnings.push(...eloOnly.flags.map((f) => ({ code: f.code, message: f.message })));
    }
  }

  // Pooled metrics and the optional calibration layer ---------------------------------
  if (allRecords.length > 0) {
    const model = summarize(allRecords);
    const base = summarize(allRecords, (r) => r.base);
    const flags = [];
    const skill = skillOf(model, base);
    if (skill.rps === null || skill.rps < MIN_SKILL) flags.push({ code: 'skill-below-8pct', message: 'Συνολικά το μοντέλο δεν ξεπερνά τις βασικές συχνότητες κατά 8% στο RPS.' });
    report.pooled = {
      matches: allRecords.length,
      metrics: { model: metricsOf(model), base: metricsOf(base) },
      skill: { vsBase: skill },
      flags,
    };

    const fit = fitCalibration(allRecords);
    const nested = nestedEvaluate(allRecords);
    const adopted = adoptedCalibration(fit, nested);
    const any = Boolean(adopted.x12 || adopted.ou25 || adopted.btts);
    tune.calibration = { adopted: any ? adopted : null, fit, nested };
    report.calibrationLayer = {
      adopted: any ? adopted : null,
      fit,
      evaluatedOn: nested.n,
      markets: Object.fromEntries(Object.entries(nested.markets).map(([k, v]) => [k, { gain: round(v.gain, 5), se: round(v.se, 5), adopt: v.adopt, reason: v.reason }])),
    };
  }

  const freshLeagues = Object.values(report.leagues).filter((r) => r.metrics && !r.stale).length;
  if (freshLeagues === 0) {
    // Nothing could be evaluated (sources down?): keep the last good files and publish nothing.
    for (const name of ['tune.json', 'report.json']) {
      if (fs.existsSync(path.join(prevDir, name))) fs.copyFileSync(path.join(prevDir, name), path.join(outDir, name));
    }
    logger.error('Καμία λίγκα δεν αξιολογήθηκε αυτή την εβδομάδα: μένουν τα προηγούμενα tune.json / report.json.');
    printSummary({ logger, report, warnings, flagged: [] });
    return { exitCode: 1, publish: false, report, tune, warnings };
  }
  writeJson(path.join(outDir, 'tune.json'), tune);
  writeJson(path.join(outDir, 'report.json'), report);

  const flagged = Object.entries(report.leagues).filter(([, r]) => !r.stale && r.flags?.some((f) => f.code === 'skill-below-8pct'));
  const failed = flagged.length > 0 || Boolean(report.pooled?.flags?.length);
  printSummary({ logger, report, warnings, flagged });
  return { exitCode: failed ? 1 : 0, publish: true, report, tune, warnings };
}

const pct1 = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1)}%`);

function printSummary({ logger, report, warnings, flagged }) {
  logger.log('\n==================== TUNING SUMMARY ====================');
  for (const [code, r] of Object.entries(report.leagues)) {
    if (!r.metrics) {
      logger.log(`[${code}] ${r.skipped ? `skipped: ${r.skipped}` : `error: ${r.error}`}`);
      continue;
    }
    if (r.stale) {
      // last week's numbers, carried over because this week's run could not evaluate the league
      logger.log(`[${code}] STALE since ${r.staleSince ?? '?'}: ${r.staleReason ?? 'unknown reason'} (last good numbers kept)`);
      continue;
    }
    const p = r.params || {};
    logger.log(
      `[${code}] ${r.matches} matches | xi ${p.xi} sigma ${p.sigma} om ${p.om} elo ${p.elo} (${r.tuning?.source ?? '?'}) | RPS ${r.metrics.model?.x12?.rps} vs base ${r.metrics.base?.x12?.rps} → skill ${pct1(r.skill?.vsBase?.rps)}` +
        ` | vs Poisson ${pct1(r.skill?.vsPoisson?.rps)} | corners NB-Poisson ${r.counts?.corners?.gain ?? '–'}` +
        (r.htft ? ` | half-time RPS skill ${pct1(r.htft.skill?.htRps)} (${r.htft.n} matches)` : ' | half-time: n/a'),
    );
  }
  if (report.pooled) logger.log(`[ALL] ${report.pooled.matches} matches | RPS skill ${pct1(report.pooled.skill.vsBase.rps)}`);
  const e = report.eloOnly;
  if (e?.metrics) {
    const lm = e.leagueModel ? ` | league model RPS ${e.leagueModel.metrics?.x12?.rps}` : '';
    logger.log(
      `[CL Elo-only on domestic matches]${e.stale ? ` STALE since ${e.staleSince ?? '?'}: ${e.staleReason ?? 'unknown reason'} (last good numbers kept)` : ''} ${e.n} matches (${(e.leagues || []).join(', ')}) | RPS ${e.metrics.model?.x12?.rps} vs base ${e.metrics.base?.x12?.rps} → skill ${pct1(e.skill?.vsBase?.rps)}${lm}` +
        (e.bigGap ? ` | gap ≥ ${e.bigGap.threshold}: ${e.bigGap.n} matches, skill ${pct1(e.bigGap.skill?.vsBase?.rps)}` : '') +
        (e.fit?.kappa ? ` | kappa ${e.fit.kappa.mean} (${e.fit.kappa.min}-${e.fit.kappa.max})` : ''),
    );
  }
  if (report.calibrationLayer) {
    const m = report.calibrationLayer.markets;
    logger.log(`Calibration layer: ${Object.entries(m).map(([k, v]) => `${k} gain ${v.gain} ± ${v.se} → ${v.adopt ? 'ADOPTED' : 'not adopted'}`).join(' | ')}`);
  }
  if (flagged.length > 0) logger.log(`\n!!! BELOW THE 8% RPS LIMIT: ${flagged.map(([c]) => c).join(', ')} - treat as a bug and look into it.`);
  logger.log(`Warnings: ${warnings.length}`);
  for (const w of warnings.slice(0, 30)) logger.log(`  - ${w.message}`);
  logger.log('========================================================');
}

