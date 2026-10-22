// Europa League from the RapidAPI listing "UEFA Europa League" (football-api.yuvron.online), free plan: 500 calls a month.
//
// Documented (openapi.json of the provider): GET /matches  query: season ("2026-27" style), status
//   (scheduled|live|halftime|finished|postponed|cancelled), from / to / date (YYYY-MM-DD), page, limit (1-200)
//   -> { data: [match], meta: { season, page, limit, total } }
//   match: id, competition, season, stage|null, round|null, kickoff (ISO), status, minute|null,
//          homeTeam / awayTeam { id, slug, name, shortName, code, crestUrl }, score { home, away }, venue
// Headers: X-RapidAPI-Key, X-RapidAPI-Host. The key travels only in the headers and is never logged.
//
// The calls are counted by the provider: no automatic retries, no 429 waiting (each retry would cost a call).
// This client has the same shape as the football-data.org client for the two things the Elo-only competitions need
// (fixtures, results); scorers are not offered.

import { BASES, isoDate } from '../config.js';
import { httpGet, HttpError } from './http.js';
import { SourceFormatError } from './csv.js';

const DAY_MS = 86400000;
const KNOCKOUT = /final|knock|play.?off|round.?of|last.?\d|quarter|semi|^r\d/i;

const describeKeys = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 15).join(',') : String(o));
const seasonParam = (startYear) => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
const stageCode = (s) => (typeof s === 'string' && s.trim() ? s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_') : null);

function teamRef(t) {
  if (!t || (!t.name && !t.shortName)) return null;
  return { id: t.id ?? null, name: t.name || t.shortName, shortName: t.shortName || t.name, tla: t.code || null };
}

const goal = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Normalise a /matches response. Matches without two known teams (a draw not made yet) are dropped. */
export function parseMatches(json) {
  if (!json || !Array.isArray(json.data)) {
    throw new SourceFormatError(`Europa League API matches: no "data" array (keys: ${describeKeys(json)})`);
  }
  const out = [];
  let skipped = 0;
  for (const m of json.data) {
    const home = teamRef(m.homeTeam);
    const away = teamRef(m.awayTeam);
    const kickoff = typeof m.kickoff === 'string' ? new Date(m.kickoff) : null;
    if (!home || !away || !kickoff || Number.isNaN(kickoff.getTime()) || m.id === undefined || m.id === null) {
      skipped++;
      continue;
    }
    out.push({
      id: m.id,
      kickoff: kickoff.toISOString(),
      status: m.status || null,
      stage: stageCode(m.stage),
      matchday: Number.isInteger(m.round) ? m.round : null,
      home,
      away,
      x: goal(m.score?.home),
      y: goal(m.score?.away),
    });
  }
  if (json.data.length > 0 && out.length === 0) {
    throw new SourceFormatError(`Europa League API matches: none of ${json.data.length} matches had id/kickoff/homeTeam/awayTeam (first match keys: ${describeKeys(json.data[0])})`);
  }
  return { matches: out, skipped, total: Number.isInteger(json.meta?.total) ? json.meta.total : null };
}

export function createRapidEuropaClient({ key, baseUrl = BASES.rapidEuropa, logger = console, fetchImpl = globalThis.fetch } = {}) {
  if (!key) throw new Error('RAPIDAPI_KEY is not set');
  const host = new URL(baseUrl).hostname;
  const state = { calls: 0, remaining: null, limit: null };

  async function request(path, params = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    state.calls++;
    const res = await httpGet(url, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host }, as: 'json', retries: 0, max429Waits: 0, fetchImpl });
    const rem = Number(res.headers.get('x-ratelimit-requests-remaining'));
    const lim = Number(res.headers.get('x-ratelimit-requests-limit'));
    if (Number.isFinite(rem)) state.remaining = rem;
    if (Number.isFinite(lim)) state.limit = lim;
    return res.body;
  }

  /** All pages of /matches for the filters (at most 4 pages of 200). */
  async function collect(params) {
    const all = [];
    let skipped = 0;
    for (let page = 1; page <= 4; page++) {
      const parsed = parseMatches(await request('/matches', { ...params, limit: 200, page }));
      all.push(...parsed.matches);
      skipped += parsed.skipped;
      if (parsed.total === null || all.length + skipped >= parsed.total || parsed.matches.length === 0) break;
    }
    return { matches: all, skipped };
  }

  /** Upcoming matches in [now, now + horizonDays). `code` is ignored (this client serves one competition). */
  async function fixtures(_code, { now = new Date(), horizonDays = 7 } = {}) {
    const end = new Date(now.getTime() + horizonDays * DAY_MS);
    const { matches, skipped } = await collect({ status: 'scheduled', from: isoDate(now), to: isoDate(new Date(end.getTime() + DAY_MS)) });
    const list = matches
      .filter((m) => new Date(m.kickoff) > now && new Date(m.kickoff) < end)
      .map((m) => ({ id: m.id, kickoff: m.kickoff, status: 'SCHEDULED', matchday: m.matchday, stage: m.stage, home: m.home, away: m.away, referee: null }))
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return { fixtures: list, requested: { from: isoDate(now), to: isoDate(end) }, skipped };
  }

  /**
   * Finished matches of a season (start year). The model needs the score after 90 minutes; this API gives one score
   * only, so knockout-round matches (where extra time may be inside it) get x = y = null: they count as played but
   * their goals are not used (nothing is invented). A 403/404/422 (season not served) gives { restricted: true }.
   */
  async function results(_code, season) {
    try {
      const { matches, skipped } = await collect({ status: 'finished', season: seasonParam(season) });
      const results = matches.map((m) => {
        const knockout = m.stage ? KNOCKOUT.test(m.stage) : false;
        const usable = !knockout && m.x !== null && m.y !== null;
        return { id: m.id, kickoff: m.kickoff, stage: m.stage, matchday: m.matchday, duration: 'REGULAR', home: m.home, away: m.away, x: usable ? m.x : null, y: usable ? m.y : null, hthg: null, htag: null };
      });
      return { restricted: false, results, skipped };
    } catch (err) {
      if (err instanceof HttpError && [403, 404, 422].includes(err.status)) return { restricted: true, results: [], skipped: 0, reason: `HTTP ${err.status}` };
      throw err;
    }
  }

  async function scorers() {
    return { restricted: true, scorers: [], reason: 'not offered by this source' };
  }

  return { request, fixtures, results, scorers, state, logger };
}
