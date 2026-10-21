// API-Football (optional, free plan: 100 requests/day, 10 per minute, header x-apisports-key).
//
// Used for two extras only: the referee of a fixture and the injuries / suspensions.
// Nothing else (no odds, no predictions). The API answers HTTP 200 even on errors,
// so every body is inspected: body.errors ({ plan: "...", token: "...", rateLimit: ... }),
// body.results and the shape of body.response. Verified response shapes:
//
//   GET /fixtures?league=39&season=2026&from=YYYY-MM-DD&to=YYYY-MM-DD
//     { get, parameters, errors: [] | {...}, results, paging: {current,total},
//       response: [ { fixture: { id, referee: "Name, Country"|null, date, timestamp, status: {short} },
//                     league: {...}, teams: { home: {id,name}, away: {id,name} }, goals, score } ] }
//   GET /injuries?ids=1-2-3                       (at most 20 fixture ids)
//     { ..., response: [ { player: { id, name: "E. Haaland", type: "Missing Fixture"|"Questionable", reason: "Knee Injury" },
//                          team: { id, name }, fixture: { id, date, timestamp }, league: {...} } ] }
//
// Budget (the free plan allows 100 requests/day; this tool stays under 40): a counter per UTC day lives in the
// cache of branch "data"; a run makes at most `runBudget` requests, none once the API reports fewer than
// `reserve` requests left (header x-ratelimit-requests-remaining), and none when a plan / key / quota error
// disabled the feature a few hours ago. The key travels only in the request header and is never logged.

import { BASES, RATE, isoDate } from '../config.js';
import { httpGet, HttpError, sleep } from './http.js';
import { SourceFormatError } from './csv.js';

/** errors may be [] , {} or { plan: "..." } -> list of messages. */
export function errorMessages(errors) {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.map(String).filter(Boolean);
  return Object.entries(errors).map(([k, v]) => `${k}: ${v}`);
}

// ------------------------------------------------------------------ access --

/**
 * Tests whether `season` is accessible: one fixtures request for the Premier
 * League (id 39) in the coming week. Returns { ok, reason, remaining, results }.
 */
export async function checkAccess({ key, season, now = new Date(), baseUrl = BASES.apiFootball, fetchImpl }) {
  if (!key) return { ok: false, reason: 'API_FOOTBALL_KEY is not set (extras disabled)', remaining: null, results: 0 };
  const from = isoDate(now);
  const to = isoDate(new Date(now.getTime() + 7 * 86400000));
  const url = `${baseUrl}/fixtures?league=39&season=${season}&from=${from}&to=${to}`;
  const res = await httpGet(url, { headers: { 'x-apisports-key': key }, as: 'json', retries: 1, fetchImpl });
  const body = res.body || {};
  const errs = errorMessages(body.errors);
  const remaining = res.headers.get('x-ratelimit-requests-remaining');
  if (errs.length > 0) {
    return { ok: false, reason: errs.join('; '), remaining, results: Number(body.results) || 0, body };
  }
  if (typeof body.results !== 'number') {
    return { ok: false, reason: 'unexpected response shape (no numeric "results")', remaining, results: 0, body };
  }
  return {
    ok: true,
    reason: body.results === 0 ? 'season accessible, but no fixtures in the next 7 days' : 'season accessible',
    remaining,
    results: body.results,
    body,
  };
}

// ----------------------------------------------------------------- parsers --

function describeKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 15).join(',') : String(obj);
}

/** Validate and normalise a /fixtures response. */
export function parseApiFixtures(body) {
  if (!body || !Array.isArray(body.response)) {
    throw new SourceFormatError(`API-Football fixtures: no "response" array (keys: ${describeKeys(body)})`);
  }
  const fixtures = [];
  let skipped = 0;
  for (const r of body.response) {
    const fx = r?.fixture;
    const home = r?.teams?.home;
    const away = r?.teams?.away;
    let ms = Number.isFinite(Number(fx?.timestamp)) && Number(fx?.timestamp) > 0 ? Number(fx.timestamp) * 1000 : Date.parse(fx?.date);
    if (!fx || fx.id === undefined || fx.id === null || !home?.name || !away?.name || !Number.isFinite(ms)) {
      skipped++;
      continue;
    }
    const referee = typeof fx.referee === 'string' && fx.referee.trim() ? fx.referee.trim() : null;
    fixtures.push({
      id: fx.id,
      kickoff: new Date(ms).toISOString(),
      status: fx.status?.short ?? null,
      home: { id: home.id ?? null, name: home.name },
      away: { id: away.id ?? null, name: away.name },
      referee,
    });
  }
  if (body.response.length > 0 && fixtures.length === 0) {
    throw new SourceFormatError(`API-Football fixtures: none of ${body.response.length} entries had fixture.id / teams / date (first entry keys: ${describeKeys(body.response[0])})`);
  }
  return { fixtures, skipped, results: Number(body.results) || fixtures.length, paging: body.paging ?? null };
}

/**
 * Why a player is missing, from the free-text "reason" of the API
 * (seen: "Knee Injury", "Knock", "Illness", "Surgery", "Red Card", "Suspended", "Yellow Cards",
 *  "Lacking Match Fitness", "Loan agreement", "Coach's decision", "Rest", "Inactive").
 * @returns {'suspension'|'injury'|'other'}
 */
export function classifyReason(reason) {
  const r = String(reason ?? '').toLowerCase();
  if (/suspen|red card|yellow card|ban\b|disciplin/.test(r)) return 'suspension';
  if (/injur|knock|illness|sick|surgery|concussion|virus|covid|strain|sprain|fracture|broken|ligament|tendon|muscle|hamstring|thigh|calf|groin|ankle|knee|hip|foot|toe|back|shoulder|wrist|leg|pelvis|achilles|head/.test(r)) return 'injury';
  return 'other';
}

/**
 * Validate and normalise an /injuries response.
 * type "Missing Fixture" -> state 'out' (will not play); "Questionable" -> state 'doubtful'.
 * Any other type is ignored (never guessed).
 */
export function parseInjuries(body) {
  if (!body || !Array.isArray(body.response)) {
    throw new SourceFormatError(`API-Football injuries: no "response" array (keys: ${describeKeys(body)})`);
  }
  const records = [];
  let ignored = 0;
  for (const r of body.response) {
    const p = r?.player;
    const fixtureId = r?.fixture?.id;
    const teamName = r?.team?.name;
    if (!p?.name || fixtureId === undefined || fixtureId === null || !teamName) {
      ignored++;
      continue;
    }
    const type = String(p.type ?? '').toLowerCase();
    const state = type.startsWith('missing') ? 'out' : type.startsWith('question') ? 'doubtful' : null;
    if (!state) {
      ignored++;
      continue;
    }
    records.push({
      fixtureId,
      teamId: r.team.id ?? null,
      teamName,
      playerId: p.id ?? null,
      playerName: String(p.name),
      state,
      reason: p.reason ?? null,
      kind: classifyReason(p.reason),
    });
  }
  if (body.response.length > 0 && records.length === 0 && ignored === body.response.length) {
    throw new SourceFormatError(`API-Football injuries: none of ${body.response.length} entries had player / team / fixture / a known type (first entry keys: ${describeKeys(body.response[0])})`);
  }
  return { records, ignored, results: Number(body.results) || records.length, paging: body.paging ?? null };
}

// ------------------------------------------------------------------ budget --

export const API_FOOTBALL_LIMITS = Object.freeze({
  dailyBudget: 40, // requests per UTC day made by this tool (the free plan allows 100)
  runBudget: 18, // requests per run
  reserve: 20, // stop when the API says fewer than this many requests are left today
  disableHours: 5, // after a plan / key / quota error the feature stays off this long
  maxIdsPerCall: 20, // injuries?ids= accepts at most 20 fixtures
});

/** The persisted counter, reset on a new UTC day and when a "disabled" mark has expired. */
export function normalizeUsage(raw, now, limits = API_FOOTBALL_LIMITS) {
  const day = isoDate(now);
  const usage = { day, calls: 0, disabled: null };
  if (raw && raw.day === day && Number.isFinite(raw.calls) && raw.calls >= 0) usage.calls = Math.floor(raw.calls);
  const at = Date.parse(raw?.disabled?.at);
  if (Number.isFinite(at) && now.getTime() - at < limits.disableHours * 3600000 && now.getTime() >= at) {
    usage.disabled = { at: raw.disabled.at, reason: String(raw.disabled.reason ?? 'disabled') };
  }
  return usage;
}

/** Error raised for everything the API-Football client refuses or the API rejects. kind: budget | plan | token | quota | rate | other */
export class ApiFootballError extends Error {
  constructor(message, kind = 'other') {
    super(message);
    this.name = 'ApiFootballError';
    this.kind = kind;
  }
}

function classifyError(messages) {
  const text = messages.join(' | ').toLowerCase();
  if (/rate ?limit|too many requests|per minute/.test(text)) return 'rate';
  if (/request limit|reached the request|daily|quota|requests?:/.test(text)) return 'quota';
  if (/plan|subscription|season|access/.test(text)) return 'plan';
  if (/token|api ?key|application key|missing|invalid|suspend/.test(text)) return 'token';
  return 'other';
}

/**
 * @param {object} o
 * @param {string} o.key
 * @param {object} o.usage     mutable counter from normalizeUsage(); the caller persists it afterwards
 * @param {Date} o.now
 */
export function createApiFootballClient({
  key,
  usage,
  now = new Date(),
  baseUrl = BASES.apiFootball,
  limits = API_FOOTBALL_LIMITS,
  minIntervalMs = RATE.apiFootballMinIntervalMs,
  rateWaitMs = RATE.apiFootballRateWaitMs,
  logger = console,
  sleepFn = sleep,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!key) throw new Error('API_FOOTBALL_KEY is not set');
  const state = { runCalls: 0, remaining: null, lastError: null };
  let nextAllowed = 0;

  function refusal() {
    if (usage.disabled) return `disabled (${usage.disabled.reason})`;
    if (state.runCalls >= limits.runBudget) return `run budget of ${limits.runBudget} requests used`;
    if (usage.calls >= limits.dailyBudget) return `daily budget of ${limits.dailyBudget} requests used`;
    if (state.remaining !== null && state.remaining < limits.reserve) return `only ${state.remaining} requests left today on the account`;
    return null;
  }

  /** Requests this run may still make. */
  function budgetLeft() {
    if (usage.disabled) return 0;
    const byRun = limits.runBudget - state.runCalls;
    const byDay = limits.dailyBudget - usage.calls;
    const byAccount = state.remaining === null ? Infinity : state.remaining - limits.reserve;
    return Math.max(0, Math.min(byRun, byDay, byAccount));
  }

  async function get(path, params = {}, { retriedRate = false } = {}) {
    const why = refusal();
    if (why) throw new ApiFootballError(`API-Football: ${why}`, 'budget');
    const wait = nextAllowed - Date.now();
    if (wait > 0) await sleepFn(wait);
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    usage.calls++; // counted before the request: a request that fails may still have been counted by the API
    state.runCalls++;
    let res;
    try {
      res = await httpGet(url, { headers: { 'x-apisports-key': key }, as: 'json', retries: 1, max429Waits: 0, fetchImpl, sleepFn });
    } catch (err) {
      nextAllowed = Date.now() + minIntervalMs;
      if (err instanceof HttpError && err.status === 429) throw new ApiFootballError('API-Football: HTTP 429 (rate limited)', 'rate');
      throw new ApiFootballError(`API-Football: ${err.message.replace(key, '***')}`, 'other');
    }
    nextAllowed = Date.now() + minIntervalMs;
    const remaining = Number(res.headers.get('x-ratelimit-requests-remaining'));
    if (res.headers.get('x-ratelimit-requests-remaining') !== null && Number.isFinite(remaining)) state.remaining = remaining;
    const body = res.body;
    if (!body || typeof body !== 'object') throw new ApiFootballError('API-Football: the response is not a JSON object', 'other');
    const messages = errorMessages(body.errors);
    if (messages.length > 0) {
      const kind = classifyError(messages);
      const text = messages.join('; ').replace(key, '***');
      if (kind === 'rate' && !retriedRate) {
        logger.warn?.(`[API-Football] per-minute limit reached, waiting ${Math.round(rateWaitMs / 1000)} s`);
        await sleepFn(rateWaitMs);
        return get(path, params, { retriedRate: true });
      }
      if (kind === 'plan' || kind === 'token' || kind === 'quota') {
        usage.disabled = { at: now.toISOString(), reason: text.slice(0, 200) };
      }
      state.lastError = text;
      throw new ApiFootballError(`API-Football: ${text}`, kind);
    }
    return body;
  }

  /** Fixtures of one league in a date window. */
  async function fixtures({ league, season, from, to }) {
    return parseApiFixtures(await get('/fixtures', { league, season, from, to }));
  }

  /** Injuries and suspensions of up to 20 fixtures at once. */
  async function injuries({ ids }) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > limits.maxIdsPerCall) {
      throw new ApiFootballError(`API-Football: injuries need 1-${limits.maxIdsPerCall} fixture ids`, 'other');
    }
    return parseInjuries(await get('/injuries', { ids: ids.join('-') }));
  }

  return { fixtures, injuries, get, budgetLeft, refusal, state, usage };
}
