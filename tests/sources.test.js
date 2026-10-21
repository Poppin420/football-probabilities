import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeasonCsv, parseCsvDate, fetchSeasonCsv } from '../src/sources/footballDataCoUk.js';
import { parseFixtures, parseScorers, createFdOrgClient } from '../src/sources/footballDataOrg.js';
import { parseEloCsv } from '../src/sources/clubElo.js';
import { errorMessages, checkAccess } from '../src/sources/apiFootball.js';
import { SourceFormatError } from '../src/sources/csv.js';
import { httpGet, HttpError } from '../src/sources/http.js';
import { dayNumberFromIso, seasonCode, csvSeasons, seasonStartYear } from '../src/config.js';

// First rows of the real 2025/26 E0.csv (odds columns cut after three).
const E0_HEADER =
  'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A';
const E0_ROWS = [
  'E0,15/08/2025,20:00,Liverpool,Bournemouth,4,2,H,1,0,H,A Taylor,19,10,10,3,7,10,6,7,1,2,0,0,1.3,6,8.5',
  'E0,16/08/2025,12:30,Aston Villa,Newcastle,0,0,D,0,0,D,C Pawson,3,16,3,3,13,11,3,6,1,1,1,0,2.25,3.5,2.9',
  'E0,16/08/2025,15:00,Brighton,Fulham,1,1,D,0,0,D,S Barrott,10,7,4,2,16,15,4,3,3,3,0,0,1.91,3.6,4',
];

test('CSV date formats dd/mm/yy and dd/mm/yyyy', () => {
  assert.equal(parseCsvDate('15/08/2025'), '2025-08-15');
  assert.equal(parseCsvDate('15/08/25'), '2025-08-15');
  assert.equal(parseCsvDate('01/09/94'), '1994-09-01');
  assert.equal(parseCsvDate('31/02/2025'), null);
  assert.equal(parseCsvDate(''), null);
  assert.equal(parseCsvDate('2025-08-15'), null);
});

test('real E0 rows parse into the expected match records, odds ignored', () => {
  const { rows, stats } = parseSeasonCsv([E0_HEADER, ...E0_ROWS].join('\n'), { div: 'E0', season: '2526' });
  assert.equal(rows.length, 3);
  const r = rows[0];
  assert.equal(r.home, 'Liverpool');
  assert.equal(r.away, 'Bournemouth');
  assert.deepEqual([r.x, r.y, r.hthg, r.htag], [4, 2, 1, 0]);
  assert.deepEqual([r.hs, r.as, r.hst, r.ast], [19, 10, 10, 3]);
  assert.deepEqual([r.hc, r.ac, r.hy, r.ay, r.hr, r.ar], [6, 7, 1, 2, 0, 0]);
  assert.equal(r.referee, 'A Taylor');
  assert.equal(r.date, '2025-08-15');
  assert.equal(r.t, dayNumberFromIso('2025-08-15'));
  assert.equal(rows[1].hr, 1);
  assert.equal(Object.keys(r).some((k) => /b365|odds/i.test(k)), false);
  assert.equal(stats.withCorners, 3);
  assert.equal(stats.withHalfTime, 3);
  assert.equal(stats.withReferee, 3);
  assert.ok(stats.columns.includes('referee'));
});

test('half-time and referee counters: an impossible half-time score (more goals than the final) is not counted', () => {
  const text = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HTHG,HTAG,Referee',
    'E0,10/08/24,Arsenal,Wolves,2,0,1,0,M Oliver',
    'E0,11/08/24,Chelsea,Everton,1,1,2,0,',
    'E0,12/08/24,Fulham,Leeds,0,3,,,A Taylor',
  ].join('\n');
  const { rows, stats } = parseSeasonCsv(text, { div: 'E0', season: '2425' });
  assert.equal(rows.length, 3);
  assert.equal(stats.withHalfTime, 1);
  assert.equal(stats.withReferee, 2);
});

test('empty cells, unfinished rows, quotes, CRLF and BOM are handled', () => {
  const text =
    '﻿' +
    [
      'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HC,AC,HY,AY,Referee',
      'E0,10/08/24,"Man United",Fulham,1,0,,,2,1,',
      'E0,11/08/24,Arsenal,Wolves,2,0,7,3,0,2,M Oliver',
      'E0,12/08/24,Chelsea,Everton,,,,,,,', // postponed / unfinished
      ',,,,,,,,,,', // blank junk row
    ].join('\r\n');
  const { rows, stats } = parseSeasonCsv(text, { div: 'E0', season: '2425' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].home, 'Man United');
  assert.equal(rows[0].hc, null); // dropped only for the corners market
  assert.equal(rows[0].hy, 2);
  assert.equal(rows[0].referee, null);
  assert.equal(stats.noResult, 1);
  assert.equal(stats.withCorners, 1);
  assert.equal(stats.withYellows, 2);
});

test('goals-only leagues (no corner/card columns) still parse', () => {
  const text = 'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR\nSC0,03/08/2025,15:00,Celtic,Hearts,3,1,H';
  const { rows, stats } = parseSeasonCsv(text, { div: 'SC0', season: '2526' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hc, null);
  assert.equal(stats.withCorners, 0);
});

test('a CSV without the required columns raises a readable format error', () => {
  assert.throws(() => parseSeasonCsv('Foo,Bar\n1,2', { div: 'E0', season: '2526' }), SourceFormatError);
});

test('fetchSeasonCsv decodes latin-1 and treats 404 as a missing file', async () => {
  const body = Buffer.from('Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\nSP1,15/08/2025,Alavés,Cádiz,1,0\n', 'latin1');
  const ok = await fetchSeasonCsv('SP1', '2526', {
    baseUrl: 'http://mock',
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  assert.equal(ok.rows[0].home, 'Alavés');
  assert.equal(ok.rows[0].away, 'Cádiz');

  const missing = await fetchSeasonCsv('SP1', '2627', {
    baseUrl: 'http://mock',
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.rows, []);
});

test('season codes follow the July rollover (Oct 2026 -> 2627)', () => {
  assert.equal(seasonCode(2026), '2627');
  assert.equal(seasonCode(1999), '9900');
  assert.equal(seasonStartYear(new Date('2026-10-18T10:00:00Z')), 2026);
  assert.equal(seasonStartYear(new Date('2027-03-01T10:00:00Z')), 2026);
  assert.equal(seasonStartYear(new Date('2026-06-30T10:00:00Z')), 2025);
  const seasons = csvSeasons(new Date('2026-10-18T10:00:00Z'));
  assert.deepEqual(seasons.map((s) => s.code), ['2324', '2425', '2526', '2627']);
  assert.deepEqual(seasons.map((s) => s.current), [false, false, false, true]);
});

// ---------------------------------------------------------------------------
const FD_MATCHES = {
  filters: { dateFrom: '2026-10-18', dateTo: '2026-10-26', status: ['SCHEDULED', 'TIMED'] },
  resultSet: { count: 3, first: '2026-10-18', last: '2026-10-25', played: 0 },
  competition: { id: 2021, name: 'Premier League', code: 'PL' },
  matches: [
    {
      id: 538001,
      utcDate: '2026-10-18T13:00:00Z',
      status: 'TIMED',
      matchday: 8,
      stage: 'REGULAR_SEASON',
      homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'x' },
      awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE', crest: 'y' },
      score: { winner: null, fullTime: { home: null, away: null } },
      referees: [{ id: 1, name: 'Michael Oliver', type: 'REFEREE' }],
    },
    {
      id: 538002,
      utcDate: '2026-10-19T15:30:00Z',
      status: 'SCHEDULED',
      matchday: 8,
      homeTeam: { id: 64, name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
      awayTeam: { id: 65, name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI' },
      referees: [],
    },
    { id: 538003, utcDate: '2026-10-20T19:00:00Z', status: 'SCHEDULED', homeTeam: { id: null, name: null }, awayTeam: {} },
  ],
};

test('football-data.org fixtures are validated and normalised', () => {
  const { fixtures, skipped } = parseFixtures(FD_MATCHES);
  assert.equal(fixtures.length, 2);
  assert.equal(skipped, 1); // teams still to be decided
  assert.equal(fixtures[0].home.name, 'Arsenal FC');
  assert.equal(fixtures[0].home.shortName, 'Arsenal');
  assert.equal(fixtures[0].referee, 'Michael Oliver');
  assert.equal(fixtures[1].referee, null);
  assert.equal(fixtures[0].kickoff, '2026-10-18T13:00:00.000Z');
  assert.throws(() => parseFixtures({ errorCode: 403, message: 'restricted' }), SourceFormatError);
  assert.throws(() => parseFixtures({ matches: [{ foo: 1 }] }), SourceFormatError);
  assert.deepEqual(parseFixtures({ matches: [] }), { fixtures: [], skipped: 0 });
});

test('football-data.org scorers: null assists / missing playedMatches are tolerated', () => {
  const json = {
    count: 2,
    filters: { season: '2026', limit: 200 },
    scorers: [
      { player: { id: 1, name: 'Erling Haaland', position: 'Offence' }, team: { id: 65, name: 'Manchester City FC', shortName: 'Man City' }, goals: 9, assists: null, penalties: 2 },
      { player: { id: 2, name: 'Bukayo Saka' }, team: { id: 57, name: 'Arsenal FC' }, playedMatches: 8, goals: 4, assists: 3 },
      { player: { name: 'Broken' }, team: null, goals: 1 },
    ],
  };
  const { scorers } = parseScorers(json);
  assert.equal(scorers.length, 2);
  assert.equal(scorers[0].assists, 0);
  assert.equal(scorers[0].penalties, 2);
  assert.equal(scorers[0].playedMatches, null);
  assert.equal(scorers[1].playedMatches, 8);
  assert.throws(() => parseScorers({ nope: [] }), SourceFormatError);
});

test('football-data.org client spaces calls >= 7 s apart and honours 429 Retry-After', async () => {
  const waits = [];
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const calls = [];
    let first429 = true;
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/matches') && first429) {
        first429 = false;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '12' } });
      }
      return new Response(JSON.stringify({ matches: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const sleepFn = async (ms) => {
      waits.push(ms);
      now += ms;
    };
    const client = createFdOrgClient({ token: 'secret-token', baseUrl: 'http://mock', minIntervalMs: 7000, sleepFn, fetchImpl });
    await client.fixtures('PL', { now: new Date('2026-10-18T10:00:00Z'), horizonDays: 7 });
    await client.fixtures('BL1', { now: new Date('2026-10-18T10:00:00Z'), horizonDays: 7 });
    assert.ok(waits.some((w) => w >= 12000 && w < 13000), `waited for Retry-After: ${waits}`);
    assert.ok(waits.some((w) => w >= 6500 && w <= 7000), `7 s spacing: ${waits}`);
    assert.ok(calls[0].includes('status=SCHEDULED%2CTIMED') || calls[0].includes('status=SCHEDULED,TIMED'));
    assert.ok(calls[0].includes('dateFrom=2026-10-18'));
    assert.ok(calls[0].includes('dateTo=2026-10-26'));
  } finally {
    Date.now = realNow;
  }
});

test('fixture window falls back to chunks when the date range is rejected, and filters by kick-off', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    seen.push([u.searchParams.get('dateFrom'), u.searchParams.get('dateTo')]);
    const from = new Date(u.searchParams.get('dateFrom'));
    const to = new Date(u.searchParams.get('dateTo'));
    if ((to - from) / 86400000 > 5) {
      return new Response(JSON.stringify({ message: 'The date range must not exceed 5 days.' }), { status: 400 });
    }
    // one match per chunk start
    return new Response(
      JSON.stringify({
        matches: [
          {
            id: Number(from) / 1e6,
            utcDate: new Date(from.getTime() + 15 * 3600000).toISOString(),
            status: 'TIMED',
            homeTeam: { id: 1, name: 'Home FC' },
            awayTeam: { id: 2, name: 'Away FC' },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const client = createFdOrgClient({ token: 't', baseUrl: 'http://mock', minIntervalMs: 0, sleepFn: async () => {}, fetchImpl, logger: {} });
  const now = new Date('2026-10-18T10:00:00Z');
  const { fixtures } = await client.fixtures('PL', { now, horizonDays: 7 });
  assert.ok(seen.length > 2, 'chunked requests were made');
  assert.ok(fixtures.length >= 2);
  assert.ok(fixtures.every((f) => new Date(f.kickoff) > now && new Date(f.kickoff) < new Date(now.getTime() + 7 * 86400000)));
  const ids = fixtures.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
});

test('scorers of a restricted season are reported, not thrown', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'restricted', errorCode: 403 }), { status: 403 });
  const client = createFdOrgClient({ token: 't', baseUrl: 'http://mock', minIntervalMs: 0, sleepFn: async () => {}, fetchImpl });
  const res = await client.scorers('PL', 2025, 200);
  assert.equal(res.restricted, true);
  assert.deepEqual(res.scorers, []);
});

test('the token never appears in thrown error messages', async () => {
  const fetchImpl = async () => new Response('forbidden', { status: 403 });
  const client = createFdOrgClient({ token: 'SUPER-SECRET-123', baseUrl: 'http://mock', minIntervalMs: 0, sleepFn: async () => {}, fetchImpl });
  await assert.rejects(client.request('/competitions/PL/matches'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.ok(!String(err.message).includes('SUPER-SECRET-123'));
    return true;
  });
});

// ---------------------------------------------------------------------------
test('ClubElo CSV: header lookup by name, "None" rank tolerated', () => {
  const text = 'Rank,Club,Country,Level,Elo,From,To\n1,Man City,ENG,1,2047.08,2026-10-10,2026-10-20\nNone,Paris SG,FRA,1,1990.5,2026-10-01,2026-10-30\n';
  const clubs = parseEloCsv(text);
  assert.equal(clubs.length, 2);
  assert.deepEqual([clubs[0].club, clubs[0].elo, clubs[0].rank, clubs[0].country], ['Man City', 2047.08, 1, 'ENG']);
  assert.equal(clubs[1].rank, null);
  assert.throws(() => parseEloCsv('a,b\n1,2'), SourceFormatError);
});

// ---------------------------------------------------------------------------
test('API-Football answers 200 even on errors: errors / results decide', async () => {
  assert.deepEqual(errorMessages([]), []);
  assert.deepEqual(errorMessages({}), []);
  assert.deepEqual(errorMessages({ plan: 'Free plans do not have access to this season' }), ['plan: Free plans do not have access to this season']);

  const planError = async () =>
    new Response(JSON.stringify({ get: 'fixtures', errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' }, results: 0, response: [] }), {
      status: 200,
      headers: { 'x-ratelimit-requests-remaining': '97' },
    });
  const bad = await checkAccess({ key: 'k', season: 2026, baseUrl: 'http://mock', fetchImpl: planError });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /do not have access/);
  assert.equal(bad.remaining, '97');

  const good = async () => new Response(JSON.stringify({ errors: [], results: 12, response: [] }), { status: 200 });
  assert.equal((await checkAccess({ key: 'k', season: 2026, baseUrl: 'http://mock', fetchImpl: good })).ok, true);
  assert.equal((await checkAccess({ key: '', season: 2026 })).ok, false);
});

test('httpGet retries 5xx and gives up after the retry budget', async () => {
  let n = 0;
  const fetchImpl = async () => (++n < 3 ? new Response('boom', { status: 503 }) : new Response('ok', { status: 200 }));
  const res = await httpGet('http://mock/x', { fetchImpl, sleepFn: async () => {}, retries: 2 });
  assert.equal(res.body, 'ok');
  assert.equal(n, 3);
  n = -10;
  await assert.rejects(httpGet('http://mock/x', { fetchImpl, sleepFn: async () => {}, retries: 1 }), HttpError);
});
