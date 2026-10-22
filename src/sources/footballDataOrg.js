// football-data.org v4 client (free tier: 10 calls/minute, header X-Auth-Token).
//
// Verified against the official v4 documentation:
//   GET /competitions/{code}/matches   query: status, dateFrom, dateTo, season
//       -> { filters, resultSet{count,first,last,played}, competition, matches[] }
//       match: id, utcDate, status, matchday, stage, homeTeam{id,name,shortName,tla},
//              awayTeam{...}, score{...}, referees[{id,name,type,nationality}]
//   GET /competitions/{code}/scorers   query: season (start year), limit
//       -> { count, filters, competition, season, scorers[] }
//       scorer: player{id,name,...}, team{id,name,shortName,tla,...},
//               goals, assists, penalties (playedMatches on some responses)
// The maximum dateFrom/dateTo range is not documented: the client asks for
// the whole window first and falls back to smaller windows on HTTP 400.

import { BASES, RATE, isoDate } from '../config.js';
import { httpGet, HttpError, sleep } from './http.js';
import { SourceFormatError } from './csv.js';

const DAY_MS = 86400000;

export function createFdOrgClient({
  token,
  baseUrl = BASES.fdOrg,
  minIntervalMs = RATE.fdOrgMinIntervalMs,
  logger = console,
  sleepFn = sleep,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!token) throw new Error('FOOTBALL_DATA_TOKEN is not set');
  let nextAllowed = 0;
  let calls = 0;
  const state = { calls: 0, lastRate: null };

  async function request(path, params = {}) {
    const wait = nextAllowed - Date.now();
    if (wait > 0) await sleepFn(wait);
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    try {
      const res = await httpGet(url, { headers: { 'X-Auth-Token': token }, as: 'json', fetchImpl, sleepFn });
      calls++;
      state.calls = calls;
      nextAllowed = Date.now() + minIntervalMs;
      const avail = res.headers.get('x-requests-available-minute');
      const reset = res.headers.get('x-requestcounter-reset');
      state.lastRate = { available: avail, reset };
      if (avail !== null && Number(avail) <= 0) {
        const resetMs = Math.min(Number(reset) || 60, 70) * 1000 + 500;
        nextAllowed = Math.max(nextAllowed, Date.now() + resetMs);
      }
      return res.body;
    } catch (err) {
      nextAllowed = Date.now() + minIntervalMs;
      throw err;
    }
  }

  /** Upcoming fixtures in [now, now + horizonDays). */
  async function fixtures(code, { now = new Date(), horizonDays = 7 } = {}) {
    const end = new Date(now.getTime() + horizonDays * DAY_MS);
    const from = isoDate(now);
    // dateTo semantics differ between doc pages (inclusive / exclusive): ask one day
    // further and filter by the real kick-off time afterwards.
    const to = isoDate(new Date(end.getTime() + DAY_MS));
    const collect = async (a, b) =>
      parseFixtures(await request(`/competitions/${code}/matches`, { status: 'SCHEDULED,TIMED', dateFrom: a, dateTo: b }));

    let parsed;
    try {
      parsed = await collect(from, to);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
      logger.warn?.(`[football-data.org] ${code}: date window rejected (${err.body.slice(0, 120)}), retrying in 4-day chunks`);
      const all = [];
      for (let d = new Date(from); d <= new Date(to); d = new Date(d.getTime() + 4 * DAY_MS)) {
        const chunkEnd = new Date(Math.min(d.getTime() + 4 * DAY_MS, new Date(to).getTime()));
        all.push(...(await collect(isoDate(d), isoDate(chunkEnd))).fixtures);
      }
      parsed = { fixtures: dedupe(all), skipped: 0 };
    }
    const fixturesInWindow = parsed.fixtures
      .filter((f) => new Date(f.kickoff) > now && new Date(f.kickoff) < end)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return { fixtures: fixturesInWindow, requested: { from, to }, skipped: parsed.skipped };
  }

  /**
   * Top scorers for a season (start year). A 403/404 (resource not in the
   * free tier, e.g. a previous season) is reported as { restricted: true }.
   */
  async function scorers(code, season, limit = 200) {
    try {
      const json = await request(`/competitions/${code}/scorers`, { season, limit });
      return { restricted: false, ...parseScorers(json), requestedLimit: limit, echoedLimit: json?.filters?.limit ?? null };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
        return { restricted: true, scorers: [], reason: `HTTP ${err.status}` };
      }
      throw err;
    }
  }

  async function teams(code) {
    return parseTeams(await request(`/competitions/${code}/teams`));
  }

  /**
   * Finished matches of a competition season (start year), used by the Elo-only model of the Champions League.
   * A 403/404 (a season outside the free tier) is reported as { restricted: true }.
   */
  async function results(code, season) {
    try {
      const json = await request(`/competitions/${code}/matches`, { season, status: 'FINISHED' });
      return { restricted: false, ...parseResults(json) };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
        return { restricted: true, results: [], skipped: 0, reason: `HTTP ${err.status}` };
      }
      throw err;
    }
  }

  /**
   * Matches of all competitions of the plan between two dates (one request): used by the live panel.
   * The free plan shows scores with a delay, so what comes back lags a little behind the real match.
   */
  async function matchesBetween(from, to) {
    return parseLive(await request('/matches', { dateFrom: from, dateTo: to }));
  }

  return { request, fixtures, scorers, teams, results, matchesBetween, state };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

function describeKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 15).join(',') : String(obj);
}

function teamRef(t) {
  if (!t || (!t.name && !t.shortName)) return null;
  return { id: t.id ?? null, name: t.name || t.shortName, shortName: t.shortName || t.name, tla: t.tla || null };
}

/** Validate and normalise a /competitions/{code}/matches response. */
export function parseFixtures(json) {
  if (!json || !Array.isArray(json.matches)) {
    throw new SourceFormatError(`football-data.org matches: no "matches" array (keys: ${describeKeys(json)})`);
  }
  const fixtures = [];
  let skipped = 0;
  for (const m of json.matches) {
    const home = teamRef(m.homeTeam);
    const away = teamRef(m.awayTeam);
    const kickoff = typeof m.utcDate === 'string' ? new Date(m.utcDate) : null;
    if (!home || !away || !kickoff || Number.isNaN(kickoff.getTime()) || m.id === undefined) {
      skipped++; // e.g. knockout ties with teams still to be decided
      continue;
    }
    const ref = Array.isArray(m.referees) ? m.referees.find((r) => r && r.name) : null;
    fixtures.push({
      id: m.id,
      kickoff: kickoff.toISOString(),
      status: m.status || null,
      matchday: m.matchday ?? null,
      stage: m.stage || null,
      home,
      away,
      referee: ref ? ref.name : null,
    });
  }
  if (json.matches.length > 0 && fixtures.length === 0) {
    throw new SourceFormatError(
      `football-data.org matches: none of ${json.matches.length} matches had id/utcDate/homeTeam/awayTeam (first match keys: ${describeKeys(json.matches[0])})`,
    );
  }
  return { fixtures, skipped };
}

/**
 * Validate and normalise a finished-matches response.
 *
 * The goals model needs the score after 90 minutes. In the knockout rounds football-data.org puts the extra-time
 * (and penalty) goals into score.fullTime and reports the 90-minute score in score.regularTime, so:
 *   duration REGULAR (or missing)  -> fullTime
 *   EXTRA_TIME / PENALTY_SHOOTOUT  -> regularTime, and when that is missing the score is NOT used (x = y = null:
 *                                     the match still counts as played, but no goals are invented)
 * The half-time score is kept for reference.
 */
export function parseResults(json) {
  if (!json || !Array.isArray(json.matches)) {
    throw new SourceFormatError(`football-data.org results: no "matches" array (keys: ${describeKeys(json)})`);
  }
  const results = [];
  let skipped = 0;
  const goalPair = (o) => {
    const h = Number(o?.home);
    const a = Number(o?.away);
    const ok = o && o.home !== null && o.away !== null && Number.isInteger(h) && Number.isInteger(a) && h >= 0 && a >= 0;
    return ok ? [h, a] : null;
  };
  for (const m of json.matches) {
    const home = teamRef(m.homeTeam);
    const away = teamRef(m.awayTeam);
    const kickoff = typeof m.utcDate === 'string' ? new Date(m.utcDate) : null;
    if (!home || !away || !kickoff || Number.isNaN(kickoff.getTime()) || m.id === undefined) {
      skipped++;
      continue;
    }
    const score = m.score || {};
    const duration = score.duration || 'REGULAR';
    const regular = duration === 'REGULAR' ? goalPair(score.fullTime) : goalPair(score.regularTime);
    const half = goalPair(score.halfTime);
    results.push({
      id: m.id,
      kickoff: kickoff.toISOString(),
      stage: m.stage || null,
      matchday: m.matchday ?? null,
      duration,
      home,
      away,
      x: regular ? regular[0] : null,
      y: regular ? regular[1] : null,
      hthg: half ? half[0] : null,
      htag: half ? half[1] : null,
    });
  }
  if (json.matches.length > 0 && results.length === 0) {
    throw new SourceFormatError(
      `football-data.org results: none of ${json.matches.length} matches had id/utcDate/homeTeam/awayTeam (first match keys: ${describeKeys(json.matches[0])})`,
    );
  }
  return { results, skipped };
}

/** Validate and normalise a /competitions/{code}/scorers response. */
export function parseScorers(json) {
  if (!json || !Array.isArray(json.scorers)) {
    throw new SourceFormatError(`football-data.org scorers: no "scorers" array (keys: ${describeKeys(json)})`);
  }
  const scorers = [];
  for (const s of json.scorers) {
    const name = s?.player?.name;
    const team = teamRef(s?.team);
    const goals = Number(s?.goals);
    if (!name || !team || !Number.isFinite(goals)) continue;
    scorers.push({
      playerId: s.player.id ?? null,
      name,
      position: s.player.position ?? null,
      team,
      goals,
      assists: Number.isFinite(Number(s.assists)) ? Number(s.assists) : 0,
      penalties: Number.isFinite(Number(s.penalties)) ? Number(s.penalties) : 0,
      playedMatches: Number.isFinite(Number(s.playedMatches)) ? Number(s.playedMatches) : null,
    });
  }
  if (json.scorers.length > 0 && scorers.length === 0) {
    throw new SourceFormatError(
      `football-data.org scorers: no usable entries (first entry keys: ${describeKeys(json.scorers[0])})`,
    );
  }
  return { scorers };
}

export function parseTeams(json) {
  if (!json || !Array.isArray(json.teams)) {
    throw new SourceFormatError(`football-data.org teams: no "teams" array (keys: ${describeKeys(json)})`);
  }
  return { teams: json.teams.map(teamRef).filter(Boolean) };
}

/** Compact one-line sample of a response item, for logs (no secrets involved). */
export function sampleOf(item, max = 500) {
  const s = JSON.stringify(item);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Normalise a /matches response for the live panel (any status). Matches without two known teams are dropped. */
export function parseLive(json) {
  if (!json || !Array.isArray(json.matches)) {
    throw new SourceFormatError(`football-data.org /matches: no "matches" array (keys: ${describeKeys(json)})`);
  }
  const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const matches = [];
  for (const m of json.matches) {
    const home = teamRef(m.homeTeam);
    const away = teamRef(m.awayTeam);
    const kickoff = typeof m.utcDate === 'string' ? new Date(m.utcDate) : null;
    if (!home || !away || !kickoff || Number.isNaN(kickoff.getTime()) || m.id === undefined) continue;
    matches.push({
      id: m.id,
      code: m.competition?.code || null,
      competition: m.competition?.name || null,
      status: m.status || null,
      minute: num(m.minute),
      injuryTime: num(m.injuryTime),
      kickoff: kickoff.toISOString(),
      lastUpdated: typeof m.lastUpdated === 'string' ? m.lastUpdated : null,
      home: { id: home.id, name: home.name, shortName: home.shortName },
      away: { id: away.id, name: away.name, shortName: away.shortName },
      score: { home: num(m.score?.fullTime?.home), away: num(m.score?.fullTime?.away), htHome: num(m.score?.halfTime?.home), htAway: num(m.score?.halfTime?.away) },
    });
  }
  return { matches };
}
