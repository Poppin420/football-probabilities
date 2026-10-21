// API-Football (optional extras): response parsers, the request counter and the client with its budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_FOOTBALL_LIMITS,
  ApiFootballError,
  checkAccess,
  classifyReason,
  createApiFootballClient,
  errorMessages,
  normalizeUsage,
  parseApiFixtures,
  parseInjuries,
} from '../src/sources/apiFootball.js';
import { SourceFormatError } from '../src/sources/csv.js';

const KEY = 'SECRET-API-FOOTBALL-KEY';
const NOW = new Date('2026-10-18T10:00:00Z');

/** A fetch that answers from `handler(url, callNumber)` -> { status?, body, headers? } and records every call. */
function fakeApi(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const r = await handler(new URL(String(url)), calls.length);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  };
  return { fetchImpl, calls };
}
const okBody = (response = [], extra = {}) => ({ get: 'x', parameters: {}, errors: [], results: response.length, paging: { current: 1, total: 1 }, response, ...extra });
function makeClient(handler, opts = {}) {
  const api = fakeApi(handler);
  const sleeps = [];
  const usage = opts.usage ?? normalizeUsage(null, NOW);
  const client = createApiFootballClient({
    key: KEY,
    usage,
    now: NOW,
    baseUrl: 'http://mock/apif',
    minIntervalMs: 0,
    rateWaitMs: 1234,
    logger: { warn() {}, log() {}, error() {} },
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: api.fetchImpl,
    ...opts.client,
  });
  return { client, usage, calls: api.calls, sleeps };
}

// ---------------------------------------------------------------------------------------------------------------
test('errors may be [] , {} or an object of messages', () => {
  assert.deepEqual(errorMessages(undefined), []);
  assert.deepEqual(errorMessages([]), []);
  assert.deepEqual(errorMessages({}), []);
  assert.deepEqual(errorMessages(['a', '', 'b']), ['a', 'b']);
  assert.deepEqual(errorMessages({ plan: 'x', token: 'y' }), ['plan: x', 'token: y']);
});

const FIXTURE_ROW = (over = {}) => ({
  fixture: { id: 1208021, referee: 'M. Oliver, England', timezone: 'UTC', date: '2026-10-20T19:00:00+00:00', timestamp: 1792522800, status: { long: 'Not Started', short: 'NS', elapsed: null } },
  league: { id: 39, name: 'Premier League', season: 2026 },
  teams: { home: { id: 42, name: 'Arsenal' }, away: { id: 49, name: 'Chelsea' } },
  goals: { home: null, away: null },
  ...over,
});

test('fixtures: referee "Name, Country", timestamps, skipped entries', () => {
  const body = okBody([
    FIXTURE_ROW(),
    FIXTURE_ROW({ fixture: { id: 2, referee: null, date: '2026-10-21T19:00:00+00:00', status: { short: 'TBD' } } }), // no timestamp: the date is used
    FIXTURE_ROW({ fixture: { id: 3, referee: '  ', timestamp: 1792609200, status: { short: 'NS' } } }),
    { fixture: { id: 4 }, teams: {} }, // broken entry
  ]);
  const { fixtures, skipped, results } = parseApiFixtures(body);
  assert.equal(fixtures.length, 3);
  assert.equal(skipped, 1);
  assert.equal(results, 4);
  assert.deepEqual(fixtures[0], {
    id: 1208021,
    kickoff: new Date(1792522800 * 1000).toISOString(),
    status: 'NS',
    home: { id: 42, name: 'Arsenal' },
    away: { id: 49, name: 'Chelsea' },
    referee: 'M. Oliver, England',
  });
  assert.equal(fixtures[1].kickoff, '2026-10-21T19:00:00.000Z');
  assert.equal(fixtures[1].referee, null);
  assert.equal(fixtures[1].status, 'TBD');
  assert.equal(fixtures[2].referee, null, 'a blank referee is no referee');
});

test('fixtures: a response of the wrong shape is a readable format error, an empty one is fine', () => {
  assert.throws(() => parseApiFixtures({ response: 'nope' }), SourceFormatError);
  assert.throws(() => parseApiFixtures(null), SourceFormatError);
  assert.throws(() => parseApiFixtures(okBody([{ foo: 1 }, { bar: 2 }])), /none of 2 entries/);
  assert.deepEqual(parseApiFixtures(okBody([])).fixtures, []);
});

const INJURY_ROW = (name, type, reason, over = {}) => ({
  player: { id: 1, name, photo: 'x', type, reason },
  team: { id: 42, name: 'Arsenal', logo: 'x' },
  fixture: { id: 1208021, timezone: 'UTC', date: '2026-10-20T19:00:00+00:00', timestamp: 1792522800 },
  league: { id: 39, season: 2026, name: 'Premier League', country: 'England' },
  ...over,
});

test('injuries: "Missing Fixture" = out, "Questionable" = doubtful, anything else is ignored', () => {
  const body = okBody([
    INJURY_ROW('B. Saka', 'Missing Fixture', 'Knee Injury'),
    INJURY_ROW('M. Odegaard', 'Questionable', 'Knock'),
    INJURY_ROW('G. Jesus', 'Missing Fixture', 'Red Card'),
    INJURY_ROW('X. Unknown', 'Something New', 'Rest'),
    INJURY_ROW('', 'Missing Fixture', 'Illness'),
    { player: { name: 'No Team', type: 'Missing Fixture' }, fixture: { id: 5 } },
  ]);
  const { records, ignored } = parseInjuries(body);
  assert.deepEqual(records.map((r) => [r.playerName, r.state, r.kind, r.fixtureId, r.teamName]), [
    ['B. Saka', 'out', 'injury', 1208021, 'Arsenal'],
    ['M. Odegaard', 'doubtful', 'injury', 1208021, 'Arsenal'],
    ['G. Jesus', 'out', 'suspension', 1208021, 'Arsenal'],
  ]);
  assert.equal(ignored, 3);
  assert.equal(parseInjuries(okBody([])).records.length, 0);
  assert.throws(() => parseInjuries({ nope: 1 }), SourceFormatError);
  assert.throws(() => parseInjuries(okBody([INJURY_ROW('A. B', 'Weird', 'x')])), /none of 1 entries/);
});

test('reasons are classified for the label only: suspension / injury / other', () => {
  const kind = classifyReason;
  for (const r of ['Red Card', 'Suspended', 'Yellow Cards', 'Disciplinary', 'Suspension']) assert.equal(kind(r), 'suspension', r);
  for (const r of ['Knee Injury', 'Knock', 'Illness', 'Surgery', 'Hamstring Injury', 'Ankle Injury', 'Concussion', 'Thigh Injury', 'Muscle Injury']) assert.equal(kind(r), 'injury', r);
  for (const r of ['Lacking Match Fitness', 'Loan agreement', "Coach's decision", 'Rest', 'Inactive', '', null, undefined]) assert.equal(kind(r), 'other', String(r));
});

// ---------------------------------------------------------------------------------------------------------------
test('the request counter: a new UTC day starts at zero, a "disabled" mark expires after 5 hours', () => {
  assert.deepEqual(normalizeUsage(null, NOW), { day: '2026-10-18', calls: 0, disabled: null });
  assert.deepEqual(normalizeUsage({ day: '2026-10-18', calls: 7, disabled: null }, NOW), { day: '2026-10-18', calls: 7, disabled: null });
  assert.equal(normalizeUsage({ day: '2026-10-17', calls: 30 }, NOW).calls, 0, 'yesterday');
  assert.equal(normalizeUsage({ day: '2026-10-18', calls: -3 }, NOW).calls, 0);
  assert.equal(normalizeUsage({ day: '2026-10-18', calls: 'many' }, NOW).calls, 0);
  assert.equal(normalizeUsage({ day: '2026-10-18', calls: 3.9 }, NOW).calls, 3);

  const at = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
  const mark = (h) => ({ day: '2026-10-18', calls: 1, disabled: { at: at(h), reason: 'plan: x' } });
  assert.deepEqual(normalizeUsage(mark(1), NOW).disabled, { at: at(1), reason: 'plan: x' });
  assert.deepEqual(normalizeUsage(mark(4.9), NOW).disabled, { at: at(4.9), reason: 'plan: x' });
  assert.equal(normalizeUsage(mark(5), NOW).disabled, null, 'expired');
  assert.equal(normalizeUsage(mark(-1), NOW).disabled, null, 'a mark from the future (clock skew) is ignored');
  assert.equal(normalizeUsage({ day: '2026-10-18', calls: 1, disabled: { at: 'garbage' } }, NOW).disabled, null);
  // the mark survives a day change (it is about the plan / key, not about the day)
  const next = new Date('2026-10-19T00:30:00Z');
  const marked = { day: '2026-10-18', calls: 20, disabled: { at: '2026-10-18T22:00:00.000Z', reason: 'quota' } };
  const n = normalizeUsage(marked, next);
  assert.equal(n.calls, 0);
  assert.equal(n.disabled?.reason, 'quota');
});

// ---------------------------------------------------------------------------------------------------------------
test('client: the key goes only into the header, the counter grows before the request, the rate header is read', async () => {
  const { client, usage, calls } = makeClient(() => ({ body: okBody([FIXTURE_ROW()]), headers: { 'x-ratelimit-requests-remaining': '93' } }));
  const res = await client.fixtures({ league: 39, season: 2026, from: '2026-10-18', to: '2026-10-26' });
  assert.equal(res.fixtures.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://mock/apif/fixtures?league=39&season=2026&from=2026-10-18&to=2026-10-26');
  assert.equal(calls[0].headers['x-apisports-key'], KEY);
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(usage.calls, 1);
  assert.equal(client.state.runCalls, 1);
  assert.equal(client.state.remaining, 93);
  assert.equal(client.budgetLeft(), Math.min(API_FOOTBALL_LIMITS.runBudget - 1, API_FOOTBALL_LIMITS.dailyBudget - 1, 93 - API_FOOTBALL_LIMITS.reserve));
});

test('client: injuries take 1-20 ids, joined with "-"', async () => {
  const { client, calls } = makeClient(() => ({ body: okBody([INJURY_ROW('B. Saka', 'Missing Fixture', 'Knee Injury')]) }));
  const res = await client.injuries({ ids: [1, 2, 3] });
  assert.equal(res.records.length, 1);
  assert.equal(calls[0].url, 'http://mock/apif/injuries?ids=1-2-3');
  await assert.rejects(client.injuries({ ids: [] }), ApiFootballError);
  await assert.rejects(client.injuries({ ids: Array.from({ length: 21 }, (_, i) => i + 1) }), /1-20 fixture ids/);
  assert.equal(calls.length, 1, 'invalid calls make no request');
});

test('client: errors inside a 200 answer are classified; plan / key / quota switch the feature off, a rate limit does not', async () => {
  const cases = [
    [{ plan: 'Free plans do not have access to this season, try from 2021 to 2023.' }, 'plan', true],
    [{ token: 'Error/Missing application key. Go to https://www.api-football.com/documentation-v3 to learn how to get your API application key.' }, 'token', true],
    [{ requests: 'You have reached the request limit for the day, Go to https://dashboard.api-football.com/ to upgrade your plan.' }, 'quota', true],
    [{ access: 'Your subscription is suspended' }, 'plan', true],
    [{ something: 'new and strange' }, 'other', false],
  ];
  for (const [errors, kind, disables] of cases) {
    const { client, usage } = makeClient(() => ({ body: okBody([], { errors }) }));
    await assert.rejects(client.fixtures({ league: 39, season: 2026, from: 'a', to: 'b' }), (err) => {
      assert.ok(err instanceof ApiFootballError);
      assert.equal(err.kind, kind, JSON.stringify(errors));
      return true;
    });
    assert.equal(Boolean(usage.disabled), disables, `${kind}: disabled mark`);
    if (disables) assert.equal(usage.disabled.at, NOW.toISOString());
  }
});

test('client: a text that contains the key never reaches an error message', async () => {
  const { client } = makeClient(() => ({ body: okBody([], { errors: { token: `Invalid key ${KEY} for this account` } }) }));
  await assert.rejects(client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => {
    assert.ok(!err.message.includes(KEY), err.message);
    assert.match(err.message, /\*\*\*/);
    return true;
  });
  const failing = makeClient(() => {
    throw new Error(`connect ECONNREFUSED while sending ${KEY}`);
  });
  await assert.rejects(failing.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => {
    assert.ok(!err.message.includes(KEY), err.message);
    assert.equal(err.kind, 'other');
    return true;
  });
});

test('client: a per-minute rate-limit answer waits once and retries; the second one is an error', async () => {
  let n = 0;
  const once = makeClient(() => (++n === 1 ? { body: okBody([], { errors: { rateLimit: 'Too many requests. Your rate limit is 10 requests per minute.' } }) } : { body: okBody([FIXTURE_ROW()]) }));
  const res = await once.client.fixtures({ league: 39, season: 2026, from: 'a', to: 'b' });
  assert.equal(res.fixtures.length, 1);
  assert.deepEqual(once.sleeps.filter((ms) => ms === 1234), [1234], 'waited the rate window once');
  assert.equal(once.usage.calls, 2, 'both requests are counted');
  assert.equal(once.usage.disabled, null);

  const always = makeClient(() => ({ body: okBody([], { errors: { rateLimit: 'Too many requests.' } }) }));
  await assert.rejects(always.client.fixtures({ league: 39, season: 2026, from: 'a', to: 'b' }), (err) => err.kind === 'rate');
  assert.equal(always.usage.calls, 2);
  assert.equal(always.usage.disabled, null);

  const http429 = makeClient(() => ({ status: 429, body: 'slow down' }));
  await assert.rejects(http429.client.fixtures({ league: 39, season: 2026, from: 'a', to: 'b' }), (err) => err.kind === 'rate');
});

test('client: non-JSON answers and HTTP errors are errors of kind "other"', async () => {
  const text = makeClient(() => ({ body: 'garbage' }));
  await assert.rejects(text.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => err instanceof ApiFootballError && err.kind === 'other');
  const server = makeClient(() => ({ status: 503, body: 'unavailable' }));
  await assert.rejects(server.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => err instanceof ApiFootballError && err.kind === 'other' && /HTTP 503/.test(err.message));
});

test('client budget: per run, per day, the account reserve and the disabled mark', async () => {
  const limits = { ...API_FOOTBALL_LIMITS, runBudget: 3, dailyBudget: 40 };
  const run = makeClient(() => ({ body: okBody([]) }), { client: { limits } });
  for (let i = 0; i < 3; i++) await run.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' });
  assert.equal(run.client.budgetLeft(), 0);
  await assert.rejects(run.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => err.kind === 'budget' && /run budget of 3/.test(err.message));
  assert.equal(run.calls.length, 3, 'a refused request makes no HTTP call');
  assert.equal(run.usage.calls, 3);

  const day = makeClient(() => ({ body: okBody([]) }), { usage: { day: '2026-10-18', calls: 39, disabled: null } });
  await day.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' });
  await assert.rejects(day.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => err.kind === 'budget' && /daily budget of 40/.test(err.message));
  assert.equal(day.client.refusal(), 'daily budget of 40 requests used');

  const low = makeClient(() => ({ body: okBody([]), headers: { 'x-ratelimit-requests-remaining': '19' } }));
  assert.equal(low.client.refusal(), null, 'unknown before the first answer');
  await low.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' });
  assert.match(low.client.refusal(), /only 19 requests left today on the account/);
  assert.equal(low.client.budgetLeft(), 0);

  const off = makeClient(() => ({ body: okBody([]) }), { usage: { day: '2026-10-18', calls: 0, disabled: { at: NOW.toISOString(), reason: 'plan: x' } } });
  assert.match(off.client.refusal(), /disabled \(plan: x\)/);
  assert.equal(off.client.budgetLeft(), 0);
  await assert.rejects(off.client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' }), (err) => err.kind === 'budget');
  assert.equal(off.calls.length, 0);
});

test('client: requests are spaced by the minimum interval (10 per minute on the free plan)', async () => {
  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    const waits = [];
    const api = fakeApi(() => ({ body: okBody([]) }));
    const client = createApiFootballClient({
      key: KEY, usage: normalizeUsage(null, NOW), now: NOW, baseUrl: 'http://mock/apif', minIntervalMs: 6500,
      logger: console, fetchImpl: api.fetchImpl,
      sleepFn: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await client.fixtures({ league: 1, season: 2026, from: 'a', to: 'b' });
    now += 1000; // one second of "processing"
    await client.fixtures({ league: 2, season: 2026, from: 'a', to: 'b' });
    await client.injuries({ ids: [1] });
    assert.equal(waits.length, 2, 'the first request does not wait');
    assert.equal(waits[0], 5500);
    assert.equal(waits[1], 6500);
  } finally {
    Date.now = realNow;
  }
});

test('checkAccess: key missing, plan error, unexpected shape, season accessible with and without fixtures', async () => {
  const respond = (body, headers = {}) => async () => new Response(JSON.stringify(body), { status: 200, headers });
  const base = { key: KEY, season: 2026, now: NOW, baseUrl: 'http://mock/apif' };
  assert.deepEqual(await checkAccess({ ...base, key: '' }), { ok: false, reason: 'API_FOOTBALL_KEY is not set (extras disabled)', remaining: null, results: 0 });
  const plan = await checkAccess({ ...base, fetchImpl: respond(okBody([], { errors: { plan: 'Free plans do not have access to this season' } }), { 'x-ratelimit-requests-remaining': '99' }) });
  assert.equal(plan.ok, false);
  assert.equal(plan.remaining, '99');
  assert.match(plan.reason, /Free plans/);
  assert.equal((await checkAccess({ ...base, fetchImpl: respond({ weird: true }) })).ok, false);
  const none = await checkAccess({ ...base, fetchImpl: respond(okBody([])) });
  assert.equal(none.ok, true);
  assert.match(none.reason, /no fixtures in the next 7 days/);
  const some = await checkAccess({ ...base, fetchImpl: respond(okBody([FIXTURE_ROW()])) });
  assert.equal(some.ok, true);
  assert.equal(some.results, 1);
  let seen = '';
  await checkAccess({ ...base, fetchImpl: async (url, init) => { seen = `${url} ${init.headers['x-apisports-key']}`; return new Response(JSON.stringify(okBody([])), { status: 200 }); } });
  assert.match(seen, /fixtures\?league=39&season=2026&from=2026-10-18&to=2026-10-25 SECRET/);
});
