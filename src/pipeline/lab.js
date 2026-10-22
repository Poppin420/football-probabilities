// Read-only diagnostics ("lab") for one league (default: the Championship). It changes NOTHING in production:
// it reads the cache of the branch "data", downloads the public CSV files of the second tiers, and prints numbers.
//
// Questions it answers (all on the same back-test as the weekly tuning, with the league's current tuned settings):
//   1. How much does the Elo prior help, with our own Elo built WITHOUT and WITH the second tiers (League One, ...)?
//   2. Do the matches of newly promoted clubs behave differently from those of established clubs?
//   3. How many of the promoted clubs have a rating at the start of the season, with and without the second tiers?
//   4. A rough ceiling of predictability: the same model fitted on the very matches it predicts (in-sample, so
//      optimistic and NOT reachable in practice; it only shows how much of the result is luck).

import fs from 'node:fs';
import path from 'node:path';
import { PHASE2_DEFAULTS } from '../model/goalsFit.js';
import { runBacktest, baseRates } from '../model/backtest.js';
import { fitLeagueModel } from '../model/goalsFit.js';
import { forecastMatch } from '../model/dc.js';
import { coreProbs, outcomeIndex } from '../model/core.js';
import { summarize } from '../model/metrics.js';
import { RATE, currentTime, eloPoolLeagues, seasonCode, seasonStartYear, LEAGUES } from '../config.js';
import { fetchSeasonCsv } from '../sources/footballDataCoUk.js';
import { createResolver } from '../sources/names.js';
import { loadAliases } from '../sources/aliases.js';
import { sleep } from '../sources/http.js';
import { createCache, readJsonIfExists, writeJson } from './cache.js';
import { makeEloAt } from './eloSnapshots.js';
import { buildOwnElo } from './ownEloData.js';
import { loadHistory } from './tune.js';
import { EVAL_SEASONS, SEASONS_BACK, oldestSeasonNeeded } from './retention.js';

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const skill = (model, base) => (base > 0 ? r4(1 - model / base) : null);

/** RPS skill of a record list against the base rates stored in the records. */
export function skillOfRecords(records) {
  if (records.length === 0) return { n: 0, rps: null, modelRps: null, baseRps: null };
  const m = summarize(records);
  const b = summarize(records, (r) => r.base);
  return { n: records.length, rps: skill(m.x12.rps, b.x12.rps), modelRps: r4(m.x12.rps), baseRps: r4(b.x12.rps) };
}

/** Split the records of a season into "involves a promoted club" / "established clubs only". */
export function splitPromoted(records, rows) {
  const bySeason = new Map();
  for (const m of rows) {
    if (!bySeason.has(m.season)) bySeason.set(m.season, new Set());
    bySeason.get(m.season).add(m.home).add(m.away);
  }
  const isPromoted = (season, key) => bySeason.has(season - 1) && bySeason.get(season - 1).size >= 16 && !bySeason.get(season - 1).has(key);
  const promoted = [];
  const established = [];
  for (const r of records) (isPromoted(r.season, r.home) || isPromoted(r.season, r.away) ? promoted : established).push(r);
  return { promoted, established, isPromoted };
}

/** In-sample ceiling: fit each evaluated season on itself and forecast the same matches. */
export function inSampleCeiling({ rows, evalYears, params }) {
  const recs = [];
  for (const y of evalYears) {
    const season = rows.filter((m) => m.season === y);
    if (season.length < 100) continue;
    const teams = [...new Set(season.flatMap((m) => [m.home, m.away]))].sort();
    const tNow = Math.max(...season.map((m) => m.t)) + 1;
    const fit = fitLeagueModel({ history: season, teams, tNow, params: { xi: 0, sigma: params.sigma, om: params.om, elo: false }, active: new Set(teams) });
    const base = baseRates(season);
    for (const m of season) {
      const { matrix } = forecastMatch(fit.model, fit.rho, m.home, m.away);
      const c = coreProbs(matrix);
      recs.push({ season: y, home: m.home, away: m.away, o: outcomeIndex(m.x, m.y), x: m.x, y: m.y, p: [c.pH, c.pD, c.pA], pOver: c.pOver25, over: m.x + m.y >= 3 ? 1 : 0, pBtts: c.pBtts, btts: m.x > 0 && m.y > 0 ? 1 : 0, base });
    }
  }
  return skillOfRecords(recs);
}

/** Promoted clubs of each evaluated season that have a rating on the first match day. */
export function ratingCoverage({ rows, evalYears, eloAt, isPromoted }) {
  const out = [];
  for (const y of evalYears) {
    const season = rows.filter((m) => m.season === y);
    if (season.length === 0) continue;
    const day = Math.min(...season.map((m) => m.t));
    const map = eloAt?.(day);
    const clubs = [...new Set(season.flatMap((m) => [m.home, m.away]))];
    const promoted = clubs.filter((k) => isPromoted(y, k));
    out.push({ season: seasonCode(y), clubs: clubs.length, promoted: promoted.length, promotedRated: promoted.filter((k) => map?.has(k)).length, establishedRated: clubs.filter((k) => !promoted.includes(k) && map?.has(k)).length });
  }
  return out;
}

export async function runLab({
  prevDir,
  outDir,
  aliasesPath,
  now = currentTime(),
  logger = console,
  code = 'ELC',
  sleepFn = sleep,
  fetchCsv = fetchSeasonCsv,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const league = LEAGUES.find((l) => l.code === code && l.enabled);
  if (!league) throw new Error(`unknown or disabled league "${code}"`);
  const cache = createCache(prevDir, outDir);
  const resolver = createResolver(loadAliases(aliasesPath).aliases);
  const cur = seasonStartYear(now);
  const years = [];
  for (let y = oldestSeasonNeeded(now); y < cur; y++) years.push(y);
  const evalYears = years.slice(-EVAL_SEASONS);
  const state = { downloads: 0 };
  const load = (l) => loadHistory({ league: l, years, cache, now, resolver, logger, sleepFn, fetchCsv, state });

  const own = (await load(league)).rows;
  const inWindow = own.filter((m) => evalYears.includes(m.season));
  if (inWindow.length === 0) throw new Error('no matches of the evaluated seasons');
  const from = Math.min(...inWindow.map((m) => m.t));
  const to = Math.max(...inWindow.map((m) => m.t)) + 1;

  const loadPool = async (withTiers) => {
    const leagueRows = [];
    const missing = [];
    for (const l of eloPoolLeagues({ withTiers })) {
      if (l.code === league.code) {
        leagueRows.push({ league: l, rows: own });
        continue;
      }
      try {
        const h = await load(l);
        leagueRows.push({ league: l, rows: h.rows });
        if (h.rows.length === 0) missing.push(l.div);
      } catch (err) {
        logger.error(`[lab] ${l.code}: ${err.message}`);
        missing.push(l.div);
      }
    }
    return { leagueRows, missing };
  };
  const cupParts = [];
  for (let y = cur - 1; y >= cur - 1 - EVAL_SEASONS - SEASONS_BACK; y--) {
    const c = cache.peek(`cup-results-CL-${y}`);
    if (c?.results) cupParts.push({ season: String(y), results: c.results });
  }
  const variants = {};
  const tuned = readJsonIfExists(path.join(prevDir, 'tune.json'))?.leagues?.[code]?.params ?? PHASE2_DEFAULTS;
  const params = { ...PHASE2_DEFAULTS, ...tuned };
  const runVariant = (name, snaps) => {
    const eloAt = snaps ? makeEloAt({ snaps, country: league.eloCountry, resolver }) : null;
    const bt = runBacktest({ matches: own, from, to, params: { ...params, elo: Boolean(snaps) }, eloAt, resolver, baseline: true });
    const sp = splitPromoted(bt.records, own);
    variants[name] = {
      all: skillOfRecords(bt.records),
      promoted: skillOfRecords(sp.promoted),
      established: skillOfRecords(sp.established),
      eloFits: bt.diag.eloFits,
      origins: bt.origins,
      coverage: ratingCoverage({ rows: own, evalYears, eloAt, isPromoted: sp.isPromoted }),
    };
    logger.log(`[lab] ${name}: skill ${variants[name].all.rps} (promoted ${variants[name].promoted.rps}, established ${variants[name].established.rps})`);
  };

  runVariant('noElo', null);
  const a = await loadPool(false);
  runVariant('ownElo', buildOwnElo({ leagueRows: a.leagueRows, cupParts, resolver, now, fromDay: from }).snaps);
  const b = await loadPool(true);
  runVariant('ownEloTiers', buildOwnElo({ leagueRows: b.leagueRows, cupParts, resolver, now, fromDay: from }).snaps);
  const ceiling = inSampleCeiling({ rows: own, evalYears, params });

  const out = {
    schema: 1,
    generatedAt: now.toISOString(),
    league: code,
    seasons: evalYears.map(seasonCode),
    params,
    matches: variants.noElo.all.n,
    tiersMissing: b.missing,
    variants,
    ceiling,
  };
  writeJson(path.join(outDir, 'lab.json'), out);
  return out;
}

const pc = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1).replace('.', ',')}%`);

/** Markdown (Greek) for the job summary. */
export function renderLab(lab) {
  const L = [];
  const V = lab.variants;
  L.push(`## Εργαστήριο Elo - ${lab.league}`);
  L.push('');
  L.push(`Σεζόν ${lab.seasons.join(', ')} · ${lab.matches} αγώνες δοκιμής · ρυθμίσεις: xi ${lab.params.xi}, sigma ${lab.params.sigma}, om ${lab.params.om}. Δεν άλλαξε τίποτα στην παραγωγή.`);
  L.push('');
  L.push('### 1. Πόσο προβλέπουμε καλύτερα από τις βασικές συχνότητες (RPS, όσο μεγαλύτερο τόσο καλύτερα· όριο 8%)');
  L.push('');
  L.push('| Εκδοχή | Όλοι οι αγώνες | Με ανεβασμένη ομάδα | Μόνο παλιές ομάδες |');
  L.push('|---|---|---|---|');
  const names = { noElo: 'Χωρίς Elo prior', ownElo: 'Δικό μας Elo (σήμερα)', ownEloTiers: 'Δικό μας Elo + δεύτερες κατηγορίες' };
  for (const k of ['noElo', 'ownElo', 'ownEloTiers']) {
    const v = V[k];
    L.push(`| ${names[k]} | ${pc(v.all.rps)} (${v.all.n}) | ${pc(v.promoted.rps)} (${v.promoted.n}) | ${pc(v.established.rps)} (${v.established.n}) |`);
  }
  L.push('');
  L.push('### 2. Πόσες ανεβασμένες ομάδες έχουν βαθμό Elo στην πρώτη αγωνιστική');
  L.push('');
  L.push('| Σεζόν | Ανεβασμένες | Χωρίς δεύτερες κατηγορίες | Με δεύτερες κατηγορίες |');
  L.push('|---|---|---|---|');
  V.ownElo.coverage.forEach((c, i) => {
    const t = V.ownEloTiers.coverage[i];
    L.push(`| ${c.season} | ${c.promoted} | ${c.promotedRated} | ${t?.promotedRated ?? '–'} |`);
  });
  L.push('');
  L.push('### 3. Ανώτατο όριο προβλεψιμότητας (προσεγγιστικό)');
  L.push('');
  L.push(`Το ίδιο μοντέλο, προσαρμοσμένο πάνω στους ίδιους τους αγώνες που προβλέπει (εκ των υστέρων, άρα αισιόδοξο και ανέφικτο στην πράξη): ${pc(lab.ceiling.rps)}. Όσο πιο κοντά είναι στο 8% αυτό το όριο, τόσο λιγότερο μπορεί να βελτιωθεί οποιοδήποτε μοντέλο στο Championship, γιατί ο βαθμός τύχης είναι μεγάλος.`);
  if (lab.tiersMissing.length > 0) {
    L.push('');
    L.push(`⚠️ Δεν κατέβηκαν δεδομένα για: ${lab.tiersMissing.join(', ')}.`);
  }
  L.push('');
  const d = V.ownEloTiers.all.rps - V.ownElo.all.rps;
  const verdict = !Number.isFinite(d) ? 'Δεν βγήκε συμπέρασμα.' : d > 0.003 ? 'Οι δεύτερες κατηγορίες ΒΟΗΘΟΥΝ: αξίζει να ανοίξουν στην παραγωγή (μεταβλητή ELO_TIERS = on).' : d < -0.003 ? 'Οι δεύτερες κατηγορίες ΔΥΣΚΟΛΕΥΟΥΝ: μην τις ανοίξεις.' : 'Η διαφορά είναι μικρότερη από 0,3 ποσοστιαίες μονάδες: δεν αξίζει η αλλαγή.';
  L.push(`**Συμπέρασμα:** ${verdict}`);
  return L.join('\n');
}
