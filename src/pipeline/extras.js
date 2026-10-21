// API-Football extras (optional): the referee of a fixture and the injuries / suspensions.
//
//  - loadExtras()          network step of the daily refresh, with the request budget (see sources/apiFootball.js)
//  - createExtrasMatcher() pure step used by the league builders: find the API fixture of one of our fixtures
//                          and split its injury records by side
//
// The extras are an add-on: whatever goes wrong here (no key, a free plan without access to the current season,
// no budget left, a network error) only means that the page shows the match without them.

import { MODEL, isoDate, seasonStartYear } from '../config.js';
import { ApiFootballError, API_FOOTBALL_LIMITS, createApiFootballClient, normalizeUsage } from '../sources/apiFootball.js';
import { sampleOf } from '../sources/footballDataOrg.js';
import { ageHours } from './cache.js';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
export const FIXTURE_MATCH_WINDOW_H = 36; // our kick-off and the API's kick-off may differ by this much

/**
 * @param {object} o
 * @param {{code:string, afId:number, fixtures:{id:number, kickoff:string}[]}[]} o.wanted  leagues with fixtures in the window
 * @returns {Promise<{ byLeague: Map<string, object>, status: {status:string, detail:string}, requests: number }>}
 */
export async function loadExtras({ env, cache, now, logger, wanted, logSample = () => {}, makeClient = createApiFootballClient, clientOptions = {} }) {
  const byLeague = new Map();
  const key = env.API_FOOTBALL_KEY;
  const cached = cache.peek('apif-extras');
  const usage = normalizeUsage(cache.peek('apif-usage'), now);
  let requests = 0;
  let status = null;

  const fromCache = (code) => {
    const e = cached?.leagues?.[code];
    if (!e || !(ageHours(e.fetchedAt, now) < MODEL.extrasCacheHours)) return null;
    return { ...e, stale: true };
  };

  if (!key) {
    return { byLeague, status: { status: 'off', detail: 'API_FOOTBALL_KEY is not set' }, requests: 0 };
  }

  const fresh = new Set();
  const failed = [];
  try {
    const client = makeClient({ key, usage, now, logger, ...clientOptions });
    const refused = client.refusal?.();
    if (refused) throw new ApiFootballError(`API-Football: ${refused}`, 'budget'); // disabled a few hours ago / budget of the day spent
    const season = seasonStartYear(now);
    const from = isoDate(now);
    const to = isoDate(new Date(now.getTime() + (MODEL.horizonDays + 1) * DAY_MS));
    const horizonEnd = now.getTime() + MODEL.extrasHorizonHours * HOUR_MS;
    const idToLeague = new Map();

    for (const w of wanted) {
      if (client.budgetLeft() <= 0) break;
      try {
        const res = await client.fixtures({ league: w.afId, season, from, to });
        if (res.fixtures[0]) logSample('API-Football fixture', sampleOf(res.fixtures[0]));
        const inWindow = res.fixtures.filter((f) => Date.parse(f.kickoff) > now.getTime() - 3 * HOUR_MS);
        byLeague.set(w.code, { fetchedAt: now.toISOString(), fixtures: inWindow, injuries: [] });
        fresh.add(w.code);
        for (const f of inWindow) idToLeague.set(f.id, w.code);
      } catch (err) {
        if (!(err instanceof ApiFootballError)) throw err;
        if (err.kind === 'budget') break;
        if (err.kind === 'plan' || err.kind === 'token' || err.kind === 'quota') throw err;
        logger.error(`[API-Football] ${w.code}: ${err.message}`);
        failed.push(w.code);
        if (failed.length >= 3) break;
      }
    }

    // Injuries for the matches kicking off soon, soonest first, up to 20 fixture ids per request.
    const ids = [];
    for (const [code, entry] of byLeague) {
      for (const f of entry.fixtures) {
        const t = Date.parse(f.kickoff);
        if (t > now.getTime() && t <= horizonEnd && (!f.status || ['NS', 'TBD'].includes(f.status))) ids.push({ id: f.id, t, code });
      }
    }
    ids.sort((a, b) => a.t - b.t);
    for (let i = 0; i < ids.length; i += API_FOOTBALL_LIMITS.maxIdsPerCall) {
      if (client.budgetLeft() <= 0) break;
      const chunk = ids.slice(i, i + API_FOOTBALL_LIMITS.maxIdsPerCall).map((x) => x.id);
      try {
        const res = await client.injuries({ ids: chunk });
        if (res.records[0]) logSample('API-Football injury', sampleOf(res.records[0]));
        for (const r of res.records) {
          const code = idToLeague.get(r.fixtureId);
          if (code) byLeague.get(code).injuries.push(r);
        }
      } catch (err) {
        if (!(err instanceof ApiFootballError)) throw err;
        if (err.kind === 'budget') break;
        if (err.kind === 'plan' || err.kind === 'token' || err.kind === 'quota') throw err;
        logger.error(`[API-Football] injuries: ${err.message}`);
        break;
      }
    }
    requests = client.state.runCalls;
    status = {
      status: fresh.size > 0 || wanted.length === 0 ? 'ok' : 'error',
      detail: `${requests} requests this run, ${usage.calls} today${client.state.remaining !== null ? `, ${client.state.remaining} left on the account` : ''}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`,
    };
    if (fresh.size === 0 && wanted.length > 0) status.detail = client.state.lastError || status.detail;
  } catch (err) {
    logger.error(`[API-Football] ${err.message}`);
    const reason = err.message.replace(/^API-Football: /, '');
    if (fresh.size > 0) {
      status = { status: 'ok', detail: `stopped early: ${reason}` };
    } else if (err instanceof ApiFootballError) {
      // plan / key / quota: the feature stays off for a few hours (usage.disabled), the page works without it
      status = { status: 'off', detail: reason };
    } else {
      status = { status: 'error', detail: reason };
    }
  } finally {
    cache.put('apif-usage', usage);
  }

  // Leagues without fresh data this run: the previous run's extras while they are young enough.
  let reused = 0;
  for (const w of wanted) {
    if (byLeague.has(w.code)) continue;
    const old = fromCache(w.code);
    if (old) {
      byLeague.set(w.code, old);
      reused++;
    }
  }
  if (reused > 0 && status.status !== 'ok') status = { status: 'stale', detail: `${status.detail}; using the extras of the previous run for ${reused} league(s)` };
  else if (reused > 0) status.detail += `; ${reused} league(s) from the previous run`;

  // Persist what the next run may need: every league's entry with its own fetch time.
  const store = { leagues: {} };
  for (const [code, e] of byLeague) store.leagues[code] = { fetchedAt: e.fetchedAt, fixtures: e.fixtures, injuries: e.injuries };
  for (const [code, e] of Object.entries(cached?.leagues || {})) {
    if (!store.leagues[code] && ageHours(e.fetchedAt, now) < MODEL.extrasCacheHours) store.leagues[code] = e;
  }
  if (Object.keys(store.leagues).length > 0) cache.put('apif-extras', store);
  return { byLeague, status, requests };
}

/**
 * Finds the API-Football fixture of one of our fixtures and the injury records of its two teams.
 * @param {{fixtures:object[], injuries:object[]}|null} extras   one league's entry from loadExtras()
 * @param {object} resolver  names.createResolver()
 * @param {Set<string>} universe  team keys of the league (the same set the fixtures were matched against)
 * @returns {(q:{home:string, away:string, kickoff:string}) => null | {apiId:number, referee:string|null, injuries:null|{home:object[], away:object[]}}}
 */
export function createExtrasMatcher({ extras, resolver, universe }) {
  if (!extras || !Array.isArray(extras.fixtures)) return () => null;
  const keyMemo = new Map();
  const keyOf = (name) => {
    if (!keyMemo.has(name)) keyMemo.set(name, resolver.matchAny([name], universe).key);
    return keyMemo.get(name);
  };
  const byFixture = new Map();
  for (const r of extras.injuries || []) {
    if (!byFixture.has(r.fixtureId)) byFixture.set(r.fixtureId, []);
    byFixture.get(r.fixtureId).push(r);
  }
  return ({ home, away, kickoff }) => {
    const t = Date.parse(kickoff);
    let best = null;
    for (const f of extras.fixtures) {
      const dt = Math.abs(Date.parse(f.kickoff) - t);
      if (!(dt <= FIXTURE_MATCH_WINDOW_H * HOUR_MS)) continue;
      if (keyOf(f.home.name) !== home || keyOf(f.away.name) !== away) continue;
      if (!best || dt < best.dt) best = { f, dt };
    }
    if (!best) return null;
    const records = byFixture.get(best.f.id) || [];
    const split = { home: [], away: [] };
    for (const r of records) {
      const k = keyOf(r.teamName);
      if (k === home) split.home.push(r);
      else if (k === away) split.away.push(r);
    }
    return { apiId: best.f.id, referee: best.f.referee ?? null, injuries: records.length > 0 ? split : null };
  };
}
