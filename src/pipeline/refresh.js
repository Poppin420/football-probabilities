// The daily pipeline: download sources, fit the models, write JSON.
//
// Policy ("never invent data"):
//  - each run starts from the previous content of branch "data" (prevDir);
//  - if fixtures or the current results cannot be fetched, the last good
//    league JSON is kept and marked stale (the UI shows "παλιά δεδομένα");
//  - fixtures whose team names cannot be matched are skipped and listed in
//    index.json "warnings".
//
// Order of work (Phase 3):
//   A. download: football-data.org fixtures / scorers and the CSV histories of the domestic leagues,
//      then fixtures / results / scorers of the Champions League;
//   B. API-Football extras (optional): referees and injuries, with a request budget;
//   C. model and write every domestic league;
//   D. the Champions League last: its Elo-only model is fitted on the domestic histories downloaded in A.

import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_PHASE, LEAGUES, MODEL, RATE, csvSeasons, cupLeagues, currentTime, dayNumber, domesticLeagues, isoDate, seasonStartYear } from '../config.js';
import { createFdOrgClient, sampleOf } from '../sources/footballDataOrg.js';
import { fetchSeasonCsv } from '../sources/footballDataCoUk.js';
import { fetchEloSnapshot } from '../sources/clubElo.js';
import { createResolver } from '../sources/names.js';
import { loadAliases } from '../sources/aliases.js';
import { sleep } from '../sources/http.js';
import { estimateHalfShare } from '../model/htft.js';
import { buildLeague } from './league.js';
import { buildChampionsLeague } from './championsLeague.js';
import { loadEloSnapshots, makeEloAt, monthStarts } from './eloSnapshots.js';
import { pooledFromDay, pooledRows } from './eloOnlyData.js';
import { loadExtras } from './extras.js';
import { runAiStep } from './aiComment.js';
import { paramsFor, readTune } from './tuneFile.js';
import { keepCacheName } from './retention.js';
import { createCache, ageHours, readJsonIfExists, writeJson } from './cache.js';

const COMPLETED_CSV_TTL_H = 24 * 30;
const PREVIOUS_SCORERS_TTL_H = 24 * 30;
const CUP_RESULTS_TTL_H = 20; // this season's cup results: about once a day
const PREVIOUS_CUP_RESULTS_TTL_H = 24 * 30;

export async function runRefresh({
  env = process.env,
  prevDir,
  outDir,
  aliasesPath,
  now = currentTime(),
  logger = console,
  only = null,
  ai = {}, // { chat, sleepFn, limits, prompt }: test hooks for the Groq step
  eloBudgetMs = 10 * 60 * 1000, // time allowed for the first download of the monthly ClubElo snapshots
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const warnings = [];
  const summaries = [];
  const entries = [];
  const sources = {
    footballDataOrg: { status: 'unknown', detail: '' },
    footballDataCoUk: { status: 'unknown', detail: '' },
    clubElo: { status: 'unknown', detail: '' },
    apiFootball: { status: 'off', detail: 'not run' },
  };
  const sampleLogged = new Set();
  const logSample = (key, what) => {
    if (env.LOG_SAMPLES === '0' || sampleLogged.has(key)) return;
    sampleLogged.add(key);
    logger.log(`[sample] ${key}: ${what}`);
  };

  const loadedAliases = loadAliases(aliasesPath);
  warnings.push(...loadedAliases.warnings);
  const resolver = createResolver(loadedAliases.aliases);
  for (const c of resolver.conflicts) {
    warnings.push({ code: 'alias-conflict', message: `aliases.json: το "${c.alias}" ανήκει σε δύο ομάδες (${c.groups.join(', ')}).` });
  }
  const cache = createCache(prevDir, outDir);

  // Parameters from the weekly tuning job (tune.json on branch "data"); the
  // Phase 2 defaults when the file is missing or invalid.
  const tune = readTune(path.join(prevDir, 'tune.json'), now);
  warnings.push(...tune.warnings);
  const builtLeagues = []; // leagues built in this run (JSON still in memory): { code, name, json, file }

  const domestic = domesticLeagues(only);
  const cups = cupLeagues(only);
  const seasons = csvSeasons(now);
  const seasonYear = seasonStartYear(now);
  logger.log(`Run at ${now.toISOString()} | seasons ${seasons.map((s) => s.code).join(', ')} | leagues ${[...domestic, ...cups].map((l) => l.code).join(', ')}`);

  // football-data.org client ---------------------------------------------------
  let client = null;
  if (env.FOOTBALL_DATA_TOKEN) {
    client = createFdOrgClient({ token: env.FOOTBALL_DATA_TOKEN, logger });
  } else {
    sources.footballDataOrg = { status: 'error', detail: 'FOOTBALL_DATA_TOKEN is not set' };
    logger.error('FOOTBALL_DATA_TOKEN is not set: every league keeps its last data (stale).');
  }

  // ClubElo (optional) ---------------------------------------------------------
  const elo = await loadElo({ cache, now, sources, logSample, logger });

  // A. Downloads ------------------------------------------------------------------
  const fetched = new Map(); // league code -> { csv, fx, scorers, cupResults } | { error }
  for (const league of domestic) {
    try {
      if (!client) throw new Error('FOOTBALL_DATA_TOKEN is not set');
      const csv = await loadCsv({ league, seasons, cache, now, sources, logSample, logger, warnings });
      const fx = await client.fixtures(league.code, { now, horizonDays: MODEL.horizonDays });
      sources.footballDataOrg = { status: 'ok', detail: `${client.state.calls} calls` };
      if (fx.fixtures[0]) logSample('football-data.org fixture', sampleOf(fx.fixtures[0]));
      const scorers = await loadScorers({ client, league, seasonYear, cache, now, logSample, logger, warnings });
      fetched.set(league.code, { csv, fx, scorers });
    } catch (err) {
      fetched.set(league.code, { error: err });
    }
  }
  for (const league of cups) {
    try {
      if (!client) throw new Error('FOOTBALL_DATA_TOKEN is not set');
      const fx = await client.fixtures(league.code, { now, horizonDays: MODEL.horizonDays });
      sources.footballDataOrg = { status: 'ok', detail: `${client.state.calls} calls` };
      if (fx.fixtures[0]) logSample(`football-data.org ${league.code} fixture`, sampleOf(fx.fixtures[0]));
      const cupResults = await loadCupResults({ client, league, seasonYear, cache, now, logSample, logger, warnings });
      const scorers = await loadScorers({ client, league, seasonYear, cache, now, logSample, logger, warnings });
      fetched.set(league.code, { fx, cupResults, scorers });
    } catch (err) {
      fetched.set(league.code, { error: err });
    }
  }

  // B. API-Football extras (referees, injuries) -------------------------------------
  const wanted = [...domestic, ...cups]
    .filter((l) => l.afId && fetched.get(l.code)?.fx?.fixtures?.length > 0)
    .map((l) => ({ code: l.code, afId: l.afId, fixtures: fetched.get(l.code).fx.fixtures }));
  let extras;
  try {
    extras = await loadExtras({ env, cache, now, logger, wanted, logSample });
  } catch (err) {
    logger.error(`[API-Football] ${err.message}`);
    extras = { byLeague: new Map(), status: { status: 'error', detail: err.message } };
  }
  sources.apiFootball = extras.status;
  logger.log(`API-Football: ${extras.status.status}${extras.status.detail ? ` (${extras.status.detail})` : ''}`);

  // The stale path shared by every league: keep the last good JSON, marked stale.
  const failLeague = (league, entry, err) => {
    logger.error(`[${league.code}] ${err.message}`);
    const prevJson = readJsonIfExists(path.join(prevDir, `${league.code}.json`));
    if (prevJson) {
      const kept = {
        ...prevJson,
        stale: true,
        staleReason: err.message,
        staleSince: prevJson.staleSince || prevJson.updatedAt,
      };
      writeJson(path.join(outDir, entry.file), kept);
      Object.assign(entry, {
        status: 'stale',
        stale: true,
        staleReason: err.message,
        updatedAt: prevJson.updatedAt,
        fixtures: prevJson.matches?.length ?? 0,
        matches: prevJson.matches?.length ?? 0,
      });
      summaries.push({ code: league.code, status: 'stale (last good data kept)', error: err.message });
    } else {
      Object.assign(entry, { status: 'error', stale: true, staleReason: err.message, updatedAt: null, fixtures: 0, matches: 0, file: null });
      summaries.push({ code: league.code, status: 'error (no previous data)', error: err.message });
    }
    warnings.push({ league: league.code, code: 'league-failed', message: `${league.code}: ${err.message}` });
  };
  const finishLeague = (league, entry, built, stalePart = null) => {
    if (stalePart) {
      built.json.stale = true;
      built.json.staleReason = stalePart;
    }
    builtLeagues.push({ code: league.code, name: league.name, json: built.json, file: entry.file });
    warnings.push(...built.warnings);
    summaries.push(built.summary);
    Object.assign(entry, {
      status: built.json.stale ? 'stale' : 'ok',
      stale: built.json.stale,
      staleReason: built.json.staleReason,
      updatedAt: built.json.updatedAt,
      fixtures: built.summary.fixtures,
      matches: built.summary.matched,
    });
  };
  const newEntry = (league) => ({ code: league.code, name: league.name, country: league.country, file: `${league.code}.json`, ...(league.eloOnly ? { eloOnly: true } : {}) });

  // C. Domestic leagues -----------------------------------------------------------------
  for (const league of domestic) {
    const entry = newEntry(league);
    try {
      const d = fetched.get(league.code);
      if (d.error) throw d.error;
      const tuned = paramsFor(tune, league.code);
      const built = buildLeague({
        league,
        seasons,
        csvBySeason: d.csv.bySeason,
        fixtures: d.fx.fixtures,
        scorers: d.scorers,
        elo,
        resolver,
        now,
        params: tuned.params,
        calibration: tune.calibration,
        tuneInfo: { source: tuned.source, generatedAt: tune.generatedAt },
        extras: extras.byLeague.get(league.code) ?? null,
      });
      built.json.sources = {
        scorers: d.scorers?.current ? { fetchedAt: d.scorers.current.fetchedAt, ageHours: Math.round(ageHours(d.scorers.current.fetchedAt, now)) } : null,
        elo: elo ? { date: elo.date, fetchedAt: elo.fetchedAt } : null,
        apiFootball: extrasInfo(extras.byLeague.get(league.code)),
      };
      finishLeague(league, entry, built, d.csv.staleParts.length > 0 ? `Αποτελέσματα από cache: ${d.csv.staleParts.join('; ')}` : null);
    } catch (err) {
      failLeague(league, entry, err);
    }
    entries.push(entry);
  }

  // D. Champions League (Elo-only) -------------------------------------------------------
  for (const league of cups) {
    const entry = newEntry(league);
    try {
      const d = fetched.get(league.code);
      if (d.error) throw d.error;
      if (!elo) throw new Error('το ClubElo δεν είναι διαθέσιμο (χρειάζεται για το μοντέλο Elo)');
      const pool = await buildPool({ fetched, seasons, resolver, cache, now, sources, logSample, logger, warnings, eloBudgetMs });
      const built = buildChampionsLeague({
        league,
        fixtures: d.fx.fixtures,
        results: d.cupResults,
        scorers: d.scorers,
        elo,
        eloAt: pool.eloAtAll,
        domesticRows: pool.rows,
        halfShare: pool.halfShare,
        resolver,
        now,
        extras: extras.byLeague.get(league.code) ?? null,
      });
      built.json.params.pool = pool.info;
      built.json.sources = {
        scorers: d.scorers?.current ? { fetchedAt: d.scorers.current.fetchedAt, ageHours: Math.round(ageHours(d.scorers.current.fetchedAt, now)) } : null,
        elo: { date: elo.date, fetchedAt: elo.fetchedAt },
        apiFootball: extrasInfo(extras.byLeague.get(league.code)),
      };
      finishLeague(league, entry, built);
    } catch (err) {
      failLeague(league, entry, err);
    }
    entries.push(entry);
  }

  // Greek comments (Groq) for the matches kicking off soon; the maths is already done.
  // A failure here only means that the deterministic Greek template stays.
  let aiStats = { enabled: false, reason: 'not run' };
  let aiCache = null;
  try {
    const result = await runAiStep({
      leagues: builtLeagues,
      prevCache: readJsonIfExists(path.join(prevDir, 'ai-cache.json')),
      now,
      env,
      logger,
      ...ai,
    });
    aiStats = result.stats;
    aiCache = result.cache;
    warnings.push(...result.warnings);
  } catch (err) {
    logger.error(`[AI] ${err.message}`);
    aiStats = { enabled: false, reason: `error: ${err.message}` };
    warnings.push({ code: 'ai-failed', message: `Σχόλιο AI: απρόσμενο σφάλμα (${err.message}) - χρησιμοποιείται το αυτόματο κείμενο.` });
    aiCache = readJsonIfExists(path.join(prevDir, 'ai-cache.json')); // keep what we had
  }
  for (const f of builtLeagues) writeJson(path.join(outDir, f.file), f.json);
  if (aiCache) writeJson(path.join(outDir, 'ai-cache.json'), aiCache);

  // Files this job does not regenerate must travel with the new orphan commit:
  // the weekly tuning's outputs and the cache entries only the tuning uses.
  cache.carryOver((name) => keepCacheName(name, now));
  for (const name of ['tune.json', 'report.json']) {
    const kept = readJsonIfExists(path.join(prevDir, name));
    if (kept) writeJson(path.join(outDir, name), kept);
  }

  const index = {
    schema: 1,
    phase: CURRENT_PHASE,
    generatedAt: now.toISOString(),
    horizonDays: MODEL.horizonDays,
    leagues: entries,
    warnings,
    sources,
    ai: aiStats,
    tune: { found: tune.found, generatedAt: tune.generatedAt, calibration: Boolean(tune.calibration) },
  };
  writeJson(path.join(outDir, 'index.json'), index);

  printSummary({ logger, summaries, warnings, sources, entries });
  const fresh = entries.filter((e) => e.status === 'ok').length;
  return { exitCode: fresh > 0 ? 0 : 1, index, summaries };
}

// ---------------------------------------------------------------------------

function extrasInfo(e) {
  if (!e) return null;
  return { fetchedAt: e.fetchedAt, stale: Boolean(e.stale), fixtures: e.fixtures?.length ?? 0, injuries: e.injuries?.length ?? 0 };
}

async function loadElo({ cache, now, sources, logSample, logger }) {
  const cached = cache.peek('elo');
  if (cached && ageHours(cached.fetchedAt, now) < MODEL.eloCacheHours) {
    cache.put('elo', cached);
    sources.clubElo = { status: 'ok', detail: `cached (${cached.date})` };
    return cached;
  }
  try {
    const snap = await fetchEloSnapshot(isoDate(now));
    const value = { fetchedAt: now.toISOString(), date: snap.date, clubs: snap.clubs };
    cache.put('elo', value);
    logSample('ClubElo club', sampleOf(snap.clubs[0]));
    sources.clubElo = { status: 'ok', detail: `${snap.clubs.length} clubs` };
    return value;
  } catch (err) {
    logger.error(`[ClubElo] ${err.message}`);
    if (cached) {
      cache.put('elo', cached);
      sources.clubElo = { status: 'stale', detail: `using cache from ${cached.fetchedAt}: ${err.message}` };
      return cached;
    }
    sources.clubElo = { status: 'error', detail: err.message };
    return null;
  }
}

async function loadCsv({ league, seasons, cache, now, sources, logSample, logger, warnings }) {
  const bySeason = new Map();
  const staleParts = [];
  let downloads = 0;
  for (const s of seasons) {
    const name = `csv-${league.div}-${s.code}`;
    const cached = cache.peek(name);
    if (!s.current && cached && ageHours(cached.fetchedAt, now) < COMPLETED_CSV_TTL_H) {
      bySeason.set(s.code, cached.rows);
      cache.put(name, cached);
      continue;
    }
    try {
      if (downloads++ > 0) await sleep(RATE.csvPauseMs);
      const res = await fetchSeasonCsv(league.div, s.code);
      if (res.missing) {
        if (cached) {
          bySeason.set(s.code, cached.rows);
          cache.put(name, cached);
        } else {
          bySeason.set(s.code, []);
          if (!s.current) warnings.push({ league: league.code, code: 'csv-missing', message: `Λείπει το αρχείο ${league.div} ${s.code} στο football-data.co.uk.` });
        }
        continue;
      }
      bySeason.set(s.code, res.rows);
      cache.put(name, { fetchedAt: now.toISOString(), rows: res.rows });
      if (res.rows[0]) logSample(`football-data.co.uk ${league.div}`, sampleOf(res.rows[0]));
    } catch (err) {
      if (!cached) {
        sources.footballDataCoUk = { status: 'error', detail: err.message };
        throw new Error(`CSV ${league.div} ${s.code}: ${err.message}`);
      }
      logger.error(`[${league.code}] CSV ${s.code} unavailable, using cache from ${cached.fetchedAt}: ${err.message}`);
      bySeason.set(s.code, cached.rows);
      cache.put(name, cached);
      staleParts.push(`${s.code} (${cached.fetchedAt.slice(0, 10)})`);
      sources.footballDataCoUk = { status: 'stale', detail: err.message };
    }
  }
  if (sources.footballDataCoUk.status === 'unknown') sources.footballDataCoUk = { status: 'ok', detail: '' };
  return { bySeason, staleParts };
}

async function loadScorers({ client, league, seasonYear, cache, now, logSample, logger, warnings }) {
  const out = {};
  for (const [label, year, ttl] of [
    ['current', seasonYear, MODEL.scorersCacheHours],
    ['previous', seasonYear - 1, PREVIOUS_SCORERS_TTL_H],
  ]) {
    const name = `scorers-${league.code}-${year}`;
    const cached = cache.peek(name);
    if (cached && ageHours(cached.fetchedAt, now) < ttl) {
      cache.put(name, cached);
      out[label] = cached;
      continue;
    }
    try {
      const res = await client.scorers(league.code, year, 200);
      const value = { fetchedAt: now.toISOString(), restricted: res.restricted, reason: res.reason || null, scorers: res.scorers };
      cache.put(name, value);
      out[label] = value;
      if (res.scorers[0]) logSample('football-data.org scorer', sampleOf(res.scorers[0]));
      if (res.restricted) {
        warnings.push({ league: league.code, code: 'scorers-restricted', message: `Σκόρερ ${league.code} ${year}: ${res.reason} (εκτός δωρεάν πλάνου) - δεν χρησιμοποιείται.` });
      } else if (res.echoedLimit !== null && Number(res.echoedLimit) < 200 && res.scorers.length >= Number(res.echoedLimit)) {
        warnings.push({ league: league.code, code: 'scorers-limit', message: `Σκόρερ ${league.code}: το API επέστρεψε όριο ${res.echoedLimit} αντί για 200.` });
      }
    } catch (err) {
      logger.error(`[${league.code}] scorers ${year}: ${err.message}`);
      if (cached) {
        cache.put(name, cached);
        out[label] = cached;
      } else {
        out[label] = null;
      }
    }
  }
  return out;
}

/**
 * Finished matches of the cup, this season and last season, for the intercept of the Elo-only model.
 * A failure is not fatal: without them the model uses the pooled domestic intercept.
 * @returns {{season:'current'|'previous', results:object[]}[]}
 */
async function loadCupResults({ client, league, seasonYear, cache, now, logSample, logger, warnings }) {
  const parts = [];
  for (const [label, year, ttl] of [
    ['current', seasonYear, CUP_RESULTS_TTL_H],
    ['previous', seasonYear - 1, PREVIOUS_CUP_RESULTS_TTL_H],
  ]) {
    const name = `cup-results-${league.code}-${year}`;
    const cached = cache.peek(name);
    if (cached && ageHours(cached.fetchedAt, now) < ttl) {
      cache.put(name, cached);
      parts.push({ season: label, results: cached.results });
      continue;
    }
    try {
      const res = await client.results(league.code, year);
      cache.put(name, { fetchedAt: now.toISOString(), restricted: res.restricted, reason: res.reason || null, results: res.results });
      parts.push({ season: label, results: res.results });
      if (res.results[0]) logSample(`football-data.org ${league.code} result`, sampleOf(res.results[0]));
      if (res.restricted) logger.log(`[${league.code}] results ${year}: ${res.reason} (outside the free plan) - not used`);
    } catch (err) {
      logger.error(`[${league.code}] results ${year}: ${err.message}`);
      if (cached) {
        cache.put(name, cached);
        parts.push({ season: label, results: cached.results });
      } else if (label === 'current') {
        warnings.push({ league: league.code, code: 'cup-results-failed', message: `${league.code}: δεν κατέβηκαν τα αποτελέσματα της σεζόν (${err.message}) - το μοντέλο χρησιμοποιεί μόνο τα εγχώρια δεδομένα.` });
      }
    }
  }
  return parts;
}

/**
 * Everything the Elo-only model needs from the domestic leagues: the monthly ClubElo snapshots, the rows of
 * the pooled regression and the pooled first-half share. Leagues that were not downloaded in this run
 * (FP_ONLY) are read from the cache or downloaded here.
 */
async function buildPool({ fetched, seasons, resolver, cache, now, sources, logSample, logger, warnings, eloBudgetMs }) {
  const tNow = dayNumber(now);
  const xi = MODEL.xi;
  const all = domesticLeagues();
  const histories = [];
  for (const league of all) {
    let csv = fetched.get(league.code)?.csv;
    if (!csv) {
      try {
        csv = await loadCsv({ league, seasons, cache, now, sources, logSample, logger, warnings });
      } catch (err) {
        logger.error(`[CL pool] ${league.code}: ${err.message}`);
        continue;
      }
    }
    const rows = [...csv.bySeason.values()].flat().map((r) => ({ ...r, home: resolver.key(r.home), away: resolver.key(r.away) }));
    histories.push({ league, rows });
  }
  if (histories.length === 0) throw new Error('δεν υπάρχουν εγχώρια δεδομένα για το μοντέλο Elo');

  const fromDay = pooledFromDay(now);
  const dates = monthStarts(fromDay, tNow);
  const countries = new Set(all.map((l) => l.eloCountry).filter(Boolean));
  const snapRes = await loadEloSnapshots({
    dates: dates.slice().reverse(), // newest first: if the time runs out, the recent months are the ones that exist
    countries,
    cache,
    now,
    logger,
    sleepFn: sleep,
    fetchElo: fetchEloSnapshot,
    deadline: Date.now() + eloBudgetMs,
  });
  if (snapRes.snaps.size === 0) throw new Error('δεν υπάρχουν μηνιαία στιγμιότυπα ClubElo για το μοντέλο Elo');
  if (snapRes.failed > 0) {
    warnings.push({ league: 'CL', code: 'elo-partial', message: `ClubElo: ${snapRes.failed} από ${dates.length} μηνιαία στιγμιότυπα λείπουν - το μοντέλο Elo χρησιμοποιεί λιγότερα δεδομένα.` });
  }

  const domestic = histories.map(({ league, rows }) => {
    const teamKeys = new Set();
    for (const m of rows) {
      teamKeys.add(m.home);
      teamKeys.add(m.away);
    }
    return { code: league.code, history: rows, eloAt: makeEloAt({ snaps: snapRes.snaps, country: league.eloCountry, resolver, teamKeys }) };
  });
  const pooled = pooledRows({ domestic, tNow, xi, fromDay });
  const halfShare = estimateHalfShare(
    domestic.flatMap((d) => d.history),
    tNow,
    xi,
  );
  return {
    rows: pooled.rows,
    halfShare,
    eloAtAll: makeEloAt({ snaps: snapRes.snaps, country: null, resolver }),
    info: {
      leagues: Object.fromEntries(Object.entries(pooled.leagues).map(([k, v]) => [k, v.used])),
      matches: pooled.matches,
      used: pooled.used,
      snapshots: snapRes.snaps.size,
      snapshotsWanted: dates.length,
    },
  };
}

function fmt(x, d = 2) {
  if (x === Infinity) return 'Poisson';
  return x === null || x === undefined || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d);
}

function printSummary({ logger, summaries, warnings, sources, entries }) {
  logger.log('\n==================== SUMMARY ====================');
  for (const s of summaries) {
    const league = LEAGUES.find((l) => l.code === s.code);
    logger.log(`\n[${s.code}] ${league?.name || ''}`);
    if (s.error) {
      logger.log(`  ${s.status}: ${s.error}`);
      continue;
    }
    logger.log(`  fixtures: ${s.fixtures} | matched: ${s.matched} | unmatched teams: ${s.unmatched.length ? s.unmatched.join(', ') : 'none'}`);
    logger.log(`  lambda range: ${fmt(s.lambdaMin)} - ${fmt(s.lambdaMax)} | rho ${fmt(s.rho, 3)} | eta ${fmt(s.eta, 3)} | c ${fmt(s.c, 3)} | converged: ${s.converged}`);
    logger.log(`  training matches: ${s.trainMatches} | promoted: ${s.promoted.length ? s.promoted.join(', ') : 'none'}`);
    if (s.eloOnly) {
      const e = s.eloOnly;
      logger.log(`  Elo-only: kappa ${fmt(e.kappa, 3)} ± ${fmt(e.kappaSe, 3)} | c pooled ${fmt(e.cPooled, 3)}, cup ${fmt(e.cCup, 3)} (weight ${fmt(e.cupWeight, 2)}, ${e.cupMatches} matches) | scorers: ${s.scorers}`);
    } else {
      logger.log(`  corners: r=${fmt(s.cornersR, 1)} resid.corr=${fmt(s.cornersCorr, 3)} | yellows r=${fmt(s.yellowsR, 1)} | scorers: ${s.scorers}`);
    }
    logger.log(`  first-half share of goals: ${fmt(s.halfShare, 3)}${s.extras ? ` | API-Football: ${s.extras.fixtures} fixtures, ${s.extras.injuries} injury records${s.extras.stale ? ' (previous run)' : ''}` : ''}`);
  }
  logger.log('\nSources:');
  for (const [k, v] of Object.entries(sources)) logger.log(`  ${k}: ${v.status}${v.detail ? ` (${v.detail})` : ''}`);
  logger.log(`\nLeague status: ${entries.map((e) => `${e.code}=${e.status}`).join(' ')}`);
  logger.log(`Warnings: ${warnings.length}`);
  for (const w of warnings.slice(0, 40)) logger.log(`  - ${w.message}`);
  logger.log('=================================================');
}
