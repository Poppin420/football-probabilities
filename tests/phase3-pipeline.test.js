// Phase 3 pipeline pieces: cup results, monthly ClubElo snapshots, the rows of the pooled regression,
// scorer set-up with absences, and the matching of API-Football fixtures to ours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, dayNumberFromIso } from '../src/config.js';
import { parseResults } from '../src/sources/footballDataOrg.js';
import { SourceFormatError } from '../src/sources/csv.js';
import { createResolver } from '../src/sources/names.js';
import { SNAPSHOT_MAX_AGE_DAYS, SNAPSHOT_SCOPE, keepClub, loadEloSnapshots, makeEloAt, monthStarts } from '../src/pipeline/eloSnapshots.js';
import { pooledFromDay, pooledRows } from '../src/pipeline/eloOnlyData.js';
import { buildMatchScorers, flagPlayers, prepareScorers } from '../src/pipeline/scorerSetup.js';
import { FIXTURE_MATCH_WINDOW_H, createExtrasMatcher } from '../src/pipeline/extras.js';
import { timeWeight } from '../src/model/dc.js';
import { goalMarkets } from '../src/model/markets.js';
import { scoreMatrix } from '../src/model/poisson.js';

const near = (a, b, tol = 1e-9, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b}`);
const day = dayNumberFromIso;

// ---------------------------------------------------------------------------------------------------------------
// football-data.org results
const team = (id, name) => ({ id, name: `${name} FC`, shortName: name, tla: name.slice(0, 3).toUpperCase() });
const fdMatch = (id, score, over = {}) => ({
  id,
  utcDate: '2026-09-16T19:00:00Z',
  status: 'FINISHED',
  matchday: 1,
  stage: 'LEAGUE_STAGE',
  homeTeam: team(1, 'Arsenal'),
  awayTeam: team(2, 'Celtic'),
  score,
  ...over,
});

test('results: the 90-minute score is used (fullTime only for regular matches)', () => {
  const { results, skipped } = parseResults({
    matches: [
      fdMatch(1, { duration: 'REGULAR', fullTime: { home: 3, away: 1 }, halfTime: { home: 2, away: 0 } }),
      fdMatch(2, { fullTime: { home: 0, away: 0 } }), // no duration: regular
      fdMatch(3, { duration: 'EXTRA_TIME', regularTime: { home: 1, away: 1 }, extraTime: { home: 1, away: 0 }, fullTime: { home: 2, away: 1 } }),
      fdMatch(4, { duration: 'PENALTY_SHOOTOUT', regularTime: { home: 0, away: 0 }, fullTime: { home: 3, away: 2 }, penalties: { home: 3, away: 2 } }),
      fdMatch(5, { duration: 'PENALTY_SHOOTOUT', fullTime: { home: 1, away: 1 } }), // no regularTime: nothing is invented
      fdMatch(6, { duration: 'REGULAR', fullTime: { home: null, away: null } }),
      fdMatch(7, { duration: 'REGULAR', fullTime: { home: -1, away: 2.5 } }),
      fdMatch(8, { duration: 'REGULAR', fullTime: { home: 2, away: 0 } }, { homeTeam: null }), // team missing: skipped
    ],
  });
  assert.equal(skipped, 1);
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual([by[1].x, by[1].y, by[1].hthg, by[1].htag], [3, 1, 2, 0]);
  assert.deepEqual([by[2].x, by[2].y], [0, 0]);
  assert.deepEqual([by[3].x, by[3].y, by[3].duration], [1, 1, 'EXTRA_TIME']);
  assert.deepEqual([by[4].x, by[4].y], [0, 0]);
  assert.deepEqual([by[5].x, by[5].y], [null, null]);
  assert.deepEqual([by[6].x, by[6].y], [null, null]);
  assert.deepEqual([by[7].x, by[7].y], [null, null]);
  assert.equal(by[1].kickoff, '2026-09-16T19:00:00.000Z');
  assert.equal(by[1].stage, 'LEAGUE_STAGE');
  assert.equal(by[1].home.shortName, 'Arsenal');
  assert.equal(by[1].hthg, 2);
  assert.equal(by[2].hthg, null);
});

test('results: a response of the wrong shape is a readable format error', () => {
  assert.throws(() => parseResults({ errorCode: 403 }), SourceFormatError);
  assert.throws(() => parseResults({ matches: [{ foo: 1 }] }), SourceFormatError);
  assert.deepEqual(parseResults({ matches: [] }), { results: [], skipped: 0 });
});

// ---------------------------------------------------------------------------------------------------------------
// monthly ClubElo snapshots
test('month starts cover the two months before the first day up to the current month', () => {
  const list = monthStarts(day('2024-07-01'), day('2026-10-18'));
  assert.equal(list[0], '2024-05-01');
  assert.equal(list.at(-1), '2026-10-01');
  assert.equal(list.length, 30);
  assert.ok(list.every((d) => d.endsWith('-01')));
  assert.deepEqual(monthStarts(day('2026-03-10'), day('2026-03-20')), ['2026-02-01', '2026-03-01']);
  assert.equal(monthStarts(day('2026-03-10'), day('2026-04-01')).at(-1), '2026-04-01', 'the 1st itself counts');
});

test('which clubs a snapshot keeps: the league countries and every club of the top two divisions', () => {
  const countries = new Set(['ENG', 'GER']);
  assert.equal(keepClub({ country: 'ENG', level: 4 }, countries), true);
  assert.equal(keepClub({ country: 'ENG', level: null }, countries), true);
  assert.equal(keepClub({ country: 'AUT', level: 1 }, countries), true);
  assert.equal(keepClub({ country: 'AUT', level: 2 }, countries), true);
  assert.equal(keepClub({ country: 'AUT', level: 3 }, countries), false);
  assert.equal(keepClub({ country: 'AUT', level: null }, countries), false);
});

function memoryCache(initial = {}) {
  const prev = new Map(Object.entries(initial));
  const out = new Map();
  return { peek: (n) => prev.get(n) ?? null, put: (n, v) => out.set(n, v), prev, out };
}
const CLUBS = [
  { club: 'Arsenal', country: 'ENG', level: 1, elo: 2000, rank: 1 },
  { club: 'Oldham', country: 'ENG', level: 4, elo: 1400, rank: 300 },
  { club: 'Salzburg', country: 'AUT', level: 1, elo: 1700, rank: 40 },
  { club: 'Lower Austria', country: 'AUT', level: 3, elo: 1300, rank: 500 },
];
const NOW = new Date('2026-10-18T10:00:00Z');

test('snapshots are downloaded once, filtered, tagged with their scope, and then read from the cache', async () => {
  const cache = memoryCache();
  const fetched = [];
  const fetchElo = async (date) => (fetched.push(date), { date, clubs: CLUBS });
  const sleeps = [];
  const args = { dates: ['2026-10-01', '2026-09-01', '2026-08-01'], countries: new Set(['ENG']), cache, now: NOW, logger: console, sleepFn: async (ms) => sleeps.push(ms), fetchElo, deadline: Date.now() + 60000 };
  const a = await loadEloSnapshots(args);
  assert.deepEqual(fetched, args.dates);
  assert.equal(a.downloads, 3);
  assert.equal(a.failed, 0);
  assert.equal(sleeps.length, 2, 'a pause between downloads, none before the first');
  const stored = cache.out.get('elo-2026-10-01');
  assert.equal(stored.scope, SNAPSHOT_SCOPE);
  assert.deepEqual(stored.clubs.map((c) => c.club), ['Arsenal', 'Oldham', 'Salzburg']);
  assert.deepEqual(stored.clubs[0], { club: 'Arsenal', country: 'ENG', level: 1, elo: 2000 });

  // the next run reads the cache of the previous branch and downloads nothing
  const cache2 = memoryCache(Object.fromEntries(cache.out));
  fetched.length = 0;
  const b = await loadEloSnapshots({ ...args, cache: cache2 });
  assert.deepEqual(fetched, []);
  assert.equal(b.downloads, 0);
  assert.equal(b.snaps.size, 3);
  assert.equal(cache2.out.size, 3, 'carried into the new branch');
});

test('snapshots written before Phase 3 (league countries only, no scope) are downloaded again; the old one is the fallback', async () => {
  const old = { date: '2026-10-01', fetchedAt: '2026-10-02T00:00:00Z', clubs: [{ club: 'Arsenal', country: 'ENG', level: 1, elo: 1990 }] };
  const cache = memoryCache({ 'elo-2026-10-01': old });
  const good = await loadEloSnapshots({ dates: ['2026-10-01'], countries: new Set(['ENG']), cache, now: NOW, logger: console, sleepFn: async () => {}, fetchElo: async (d) => ({ date: d, clubs: CLUBS }), deadline: Date.now() + 1000 });
  assert.equal(good.downloads, 1);
  assert.equal(good.snaps.get('2026-10-01').length, 3);
  assert.equal(cache.out.get('elo-2026-10-01').scope, SNAPSHOT_SCOPE);

  const quiet = { error() {}, log() {} };
  const failing = memoryCache({ 'elo-2026-10-01': old });
  const bad = await loadEloSnapshots({ dates: ['2026-10-01'], countries: new Set(['ENG']), cache: failing, now: NOW, logger: quiet, sleepFn: async () => {}, fetchElo: async () => { throw new Error('down'); }, deadline: Date.now() + 1000 });
  assert.equal(bad.failed, 1);
  assert.equal(bad.snaps.get('2026-10-01')[0].elo, 1990, 'the old narrow snapshot is better than none');
  assert.deepEqual(failing.out.get('elo-2026-10-01'), old, 'and it is kept for the next run');

  const none = await loadEloSnapshots({ dates: ['2026-09-01'], countries: new Set(['ENG']), cache: memoryCache(), now: NOW, logger: quiet, sleepFn: async () => {}, fetchElo: async () => { throw new Error('down'); }, deadline: Date.now() + 1000 });
  assert.equal(none.failed, 1);
  assert.equal(none.snaps.size, 0);
});

test('snapshots: a spent time budget stops the downloads, a snapshot without wanted clubs is a failure', async () => {
  const quiet = { error() {}, log() {} };
  const fetched = [];
  const cache = memoryCache();
  const r = await loadEloSnapshots({ dates: ['2026-10-01', '2026-09-01'], countries: new Set(['ENG']), cache, now: NOW, logger: quiet, sleepFn: async () => {}, fetchElo: async (d) => (fetched.push(d), { date: d, clubs: CLUBS }), deadline: Date.now() - 1 });
  assert.deepEqual(fetched, []);
  assert.equal(r.failed, 2);
  assert.equal(r.snaps.size, 0);

  const empty = await loadEloSnapshots({ dates: ['2026-10-01'], countries: new Set(['ENG']), cache: memoryCache(), now: NOW, logger: quiet, sleepFn: async () => {}, fetchElo: async (d) => ({ date: d, clubs: [{ club: 'Lower Austria', country: 'AUT', level: 3, elo: 1300 }] }), deadline: Date.now() + 1000 });
  assert.equal(empty.failed, 1);
  assert.equal(empty.snaps.size, 0);
});

test('Elo by day: the latest snapshot not after the day, at most 62 days old; country filter; best division wins', () => {
  const resolver = createResolver({});
  const snaps = new Map([
    ['2026-09-01', [
      { club: 'Arsenal', country: 'ENG', level: 1, elo: 1900 },
      { club: 'Bayern', country: 'GER', level: 1, elo: 2000 },
    ]],
    ['2026-10-01', [
      { club: 'Arsenal', country: 'ENG', level: 1, elo: 1950 },
      { club: 'Arsenal', country: 'ENG', level: 2, elo: 1500 }, // a lower-division entry of the same name: the top division wins
      { club: 'Bayern', country: 'GER', level: 1, elo: 2010 },
      { club: 'Twin', country: 'ENG', level: 2, elo: 1500 },
      { club: 'Twin', country: 'ENG', level: 2, elo: 1550 }, // same division: the higher rating
    ]],
  ]);
  const all = makeEloAt({ snaps, country: null, resolver });
  const eng = makeEloAt({ snaps, country: 'ENG', resolver });
  assert.equal(all(day('2026-10-15')).get('arsenal'), 1950);
  assert.equal(all(day('2026-09-20')).get('arsenal'), 1900);
  assert.equal(all(day('2026-10-01')).get('bayern'), 2010, 'the snapshot of the day itself');
  assert.equal(all(day('2026-08-31')), null, 'before the first snapshot');
  assert.ok(all(day('2026-10-01') + SNAPSHOT_MAX_AGE_DAYS) instanceof Map);
  assert.equal(all(day('2026-10-01') + SNAPSHOT_MAX_AGE_DAYS + 1), null, 'older than 62 days');
  assert.equal(all(day('2026-10-15')).get('twin'), 1550);
  assert.deepEqual([...eng(day('2026-10-15')).keys()].sort(), ['arsenal', 'twin']);
  assert.ok(!eng(day('2026-10-15')).has('bayern'));
  // a team key of the league's own spelling gets one unique fuzzy attempt
  const fuzzy = makeEloAt({ snaps, country: 'ENG', resolver, teamKeys: new Set(['arsenall', 'nobody at all']) });
  assert.equal(fuzzy(day('2026-10-15')).get('arsenall'), 1950);
  assert.ok(!fuzzy(day('2026-10-15')).has('nobody at all'));
  assert.equal(fuzzy(day('2026-10-15')), fuzzy(day('2026-10-16')), 'memoised per snapshot');
});

// ---------------------------------------------------------------------------------------------------------------
// the rows of the pooled regression
test('the pooled sample starts on 1 July two seasons back', () => {
  assert.equal(pooledFromDay(new Date('2026-10-18T10:00:00Z')), day('2024-07-01'));
  assert.equal(pooledFromDay(new Date('2027-03-01T10:00:00Z')), day('2024-07-01'));
  assert.equal(pooledFromDay(new Date('2026-06-30T10:00:00Z')), day('2023-07-01'));
});

test('pooled rows: window, integer goals, both ratings known, Elo difference / 800, time weight', () => {
  const tNow = day('2026-10-18');
  const fromDay = day('2024-07-01');
  const eloAt = (t) => (t < day('2024-08-01') ? null : new Map([['a', 1900], ['b', 1700], ['d', 1800]]));
  const history = [
    { t: day('2024-06-30'), home: 'a', away: 'b', x: 1, y: 0 }, // before the sample
    { t: day('2024-07-15'), home: 'a', away: 'b', x: 1, y: 0 }, // no snapshot yet
    { t: day('2025-01-10'), home: 'a', away: 'b', x: 2, y: 1 }, // used, d = +0.25
    { t: day('2025-02-10'), home: 'b', away: 'a', x: 0, y: 3 }, // used, d = -0.25
    { t: day('2025-03-10'), home: 'a', away: 'c', x: 1, y: 1 }, // c has no rating
    { t: day('2025-04-10'), home: 'a', away: 'd', x: null, y: null }, // no score
    { t: day('2025-05-10'), home: 'a', away: 'd', x: 1.5, y: 0 }, // not an integer
    { t: day('2026-10-18'), home: 'a', away: 'd', x: 1, y: 0 }, // today: not played yet
    { t: day('2026-10-10'), home: 'd', away: 'a', x: 1, y: 1 }, // used, d = -0.125
  ];
  const out = pooledRows({ domestic: [{ code: 'XX', history, eloAt }, { code: 'YY', history: [], eloAt }], tNow, xi: 0.0019, fromDay });
  assert.equal(out.rows.length, 3);
  assert.equal(out.used, 3);
  assert.deepEqual(out.leagues, { XX: { matches: 5, used: 3 }, YY: { matches: 0, used: 0 } });
  assert.equal(out.matches, 5);
  assert.deepEqual(out.rows.map((r) => [r.x, r.y, r.d]), [[2, 1, 0.25], [0, 3, -0.25], [1, 1, -0.125]]);
  near(out.rows[0].w, timeWeight(day('2025-01-10'), tNow, 0.0019));
  assert.ok(out.rows[2].w > out.rows[1].w && out.rows[1].w > out.rows[0].w, 'recent matches weigh more');
});

// ---------------------------------------------------------------------------------------------------------------
// scorers with absences
const scorerRow = (name, teamName, goals, id = null) => ({ playerId: id ?? name, name, position: null, team: { id: 1, name: `${teamName} FC`, shortName: teamName }, goals, assists: 0, penalties: 0, playedMatches: 5 });
const teamKeyOf = (t) => (t.shortName === 'Unknown' ? null : t.shortName.toLowerCase());

test('scorer set-up: nothing without a usable current list; last season is optional', () => {
  const N0 = new Map([['arsenal', 5]]);
  const N1 = new Map([['arsenal', 8]]);
  assert.equal(prepareScorers({ scorers: null, teamKeyOf, N0, N1 }), null);
  assert.equal(prepareScorers({ scorers: { current: { restricted: true, scorers: [] } }, teamKeyOf, N0, N1 }), null);
  assert.equal(prepareScorers({ scorers: { current: { scorers: [] } }, teamKeyOf, N0, N1 }), null);

  const current = { scorers: [scorerRow('Bukayo Saka', 'Arsenal', 4, 7), scorerRow('Gabriel Jesus', 'Arsenal', 2, 8), scorerRow('Lost Player', 'Unknown', 9, 9)] };
  const previous = { scorers: [scorerRow('Bukayo Saka', 'Arsenal', 11, 7), scorerRow('Gabriel Jesus', 'Chelsea', 6, 8)] };
  const setup = prepareScorers({ scorers: { current, previous }, teamKeyOf, N0, N1 });
  assert.deepEqual(setup.byTeam.get('arsenal'), [
    { name: 'Bukayo Saka', G0: 4, G1: 11, sameClub: true },
    { name: 'Gabriel Jesus', G0: 2, G1: 6, sameClub: false },
  ]);
  assert.ok(!setup.byTeam.has('unknown'), 'a club that cannot be matched is skipped');
  assert.equal(setup.N0, N0);
  assert.equal(setup.prior.source, 'default');
  assert.deepEqual([setup.a, setup.b], [1, 12]);

  const restricted = prepareScorers({ scorers: { current, previous: { restricted: true, scorers: [] } }, teamKeyOf, N0, N1 });
  assert.deepEqual(restricted.byTeam.get('arsenal').map((p) => p.G1), [0, 0]);
});

test('absence flags: unique matches only, "out" wins over "doubtful", the roster is not modified', () => {
  const roster = [
    { name: 'Bukayo Saka', G0: 4, G1: 0, sameClub: true },
    { name: 'Gabriel Jesus', G0: 3, G1: 0, sameClub: true },
    { name: 'Gabriel Martinelli', G0: 2, G1: 0, sameClub: true },
    { name: 'Kai Havertz', G0: 1, G1: 0, sameClub: true },
  ];
  assert.equal(flagPlayers(roster, null), roster);
  assert.equal(flagPlayers(roster, []), roster);
  assert.equal(flagPlayers(roster, [{ playerName: 'X. Nobody', state: 'out', kind: 'injury' }]), roster, 'nothing matched: the same roster');

  const flagged = flagPlayers(roster, [
    { playerName: 'B. Saka', state: 'doubtful', kind: 'injury' },
    { playerName: 'B. Saka', state: 'out', kind: 'suspension' }, // out wins whatever the order
    { playerName: 'K. Havertz', state: 'doubtful', kind: 'other' },
    { playerName: 'Gabriel', state: 'out', kind: 'injury' }, // ambiguous: Jesus and Martinelli
  ]);
  assert.deepEqual(flagged.map((p) => [p.absent, p.doubtful, p.kind]), [
    [true, undefined, 'suspension'],
    [undefined, undefined, undefined],
    [undefined, undefined, undefined],
    [undefined, true, 'other'],
  ]);
  assert.equal(roster[0].absent, undefined);

  const reverse = flagPlayers(roster, [{ playerName: 'B. Saka', state: 'out', kind: 'injury' }, { playerName: 'B. Saka', state: 'doubtful', kind: 'other' }]);
  assert.equal(reverse[0].absent, true);
  assert.equal(reverse[0].kind, 'injury');
});

test('match scorers: absentees leave the list and show under absences only when they would have been displayed', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ name: `Player ${String.fromCharCode(65 + i)}`, G0: 12 - i, G1: 0, sameClub: true }));
  const setup = { byTeam: new Map([['home', players], ['away', players.slice(0, 3)]]), N0: new Map([['home', 10], ['away', 10]]), N1: new Map(), a: 1, b: 12 };
  const M = scoreMatrix(1.6, 1.1, -0.05);
  const { marginals } = goalMarkets(M);
  const args = { setup, home: 'home', away: 'away', lam: 1.6, mu: 1.1, marginals, lamBarOf: () => 1.4 };

  const plain = buildMatchScorers(args);
  assert.equal(plain.absences, undefined);
  assert.equal(plain.home.length, MODEL.scorersPerTeam);
  assert.equal(plain.away.length, 3);

  const withInjuries = buildMatchScorers({
    ...args,
    injuries: {
      home: [
        { playerName: 'Player A', state: 'out', kind: 'injury' }, // the top scorer
        { playerName: 'Player L', state: 'out', kind: 'suspension' }, // 12th: would not be displayed anyway
        { playerName: 'Player C', state: 'doubtful', kind: 'injury' },
      ],
      away: [],
    },
  });
  assert.equal(withInjuries.absences.source, 'api-football');
  assert.deepEqual(withInjuries.absences.home.map((p) => [p.name, p.goals, p.kind]), [['Player A', 12, 'injury']]);
  assert.deepEqual(withInjuries.absences.away, []);
  assert.ok(!withInjuries.home.some((p) => p.name === 'Player A' || p.name === 'Player L'));
  assert.equal(withInjuries.home.length, MODEL.scorersPerTeam, 'the list is filled up with the next players');
  const c = withInjuries.home.find((p) => p.name === 'Player C');
  assert.equal(c.doubtful, true);
  assert.equal(c.kind, 'injury');
  assert.ok(withInjuries.home.every((p) => p.anytime > 0 && p.anytime < 1));

  const nobody = buildMatchScorers({ ...args, setup: { ...setup, byTeam: new Map() } });
  assert.equal(nobody, null);
});

// ---------------------------------------------------------------------------------------------------------------
// API-Football fixture -> our fixture
test('extras matcher: same teams in the same order within 36 hours; injuries split by side', () => {
  assert.equal(FIXTURE_MATCH_WINDOW_H, 36);
  const resolver = createResolver({ 'Man City': ['Manchester City', 'Manchester City FC'] });
  const universe = new Set(['man city', 'arsenal', 'chelsea']);
  const extras = {
    fixtures: [
      { id: 10, kickoff: '2026-10-20T19:00:00.000Z', status: 'NS', home: { name: 'Manchester City' }, away: { name: 'Arsenal' }, referee: 'A. Taylor, England' },
      { id: 11, kickoff: '2026-10-21T19:00:00.000Z', status: 'NS', home: { name: 'Chelsea' }, away: { name: 'Arsenal' }, referee: null },
      { id: 12, kickoff: '2026-10-20T19:00:00.000Z', status: 'NS', home: { name: 'Nobody FC' }, away: { name: 'Arsenal' }, referee: 'Z' },
    ],
    injuries: [
      { fixtureId: 10, teamName: 'Manchester City', playerName: 'E. Haaland', state: 'out', kind: 'injury' },
      { fixtureId: 10, teamName: 'Arsenal', playerName: 'B. Saka', state: 'doubtful', kind: 'injury' },
      { fixtureId: 10, teamName: 'Somebody Else', playerName: 'X. Y', state: 'out', kind: 'other' },
      { fixtureId: 11, teamName: 'Chelsea', playerName: 'C. Palmer', state: 'out', kind: 'injury' },
    ],
  };
  const find = createExtrasMatcher({ extras, resolver, universe });
  const hit = find({ home: 'man city', away: 'arsenal', kickoff: '2026-10-20T20:30:00.000Z' });
  assert.equal(hit.apiId, 10);
  assert.equal(hit.referee, 'A. Taylor, England');
  assert.deepEqual(hit.injuries.home.map((r) => r.playerName), ['E. Haaland']);
  assert.deepEqual(hit.injuries.away.map((r) => r.playerName), ['B. Saka']);

  const noInjuries = find({ home: 'chelsea', away: 'arsenal', kickoff: '2026-10-21T19:00:00.000Z' });
  assert.equal(noInjuries.apiId, 11);
  assert.equal(noInjuries.referee, null);
  assert.equal(noInjuries.injuries.home.length, 1);
  assert.equal(noInjuries.injuries.away.length, 0);

  assert.equal(find({ home: 'arsenal', away: 'man city', kickoff: '2026-10-20T19:00:00.000Z' }), null, 'home and away are not interchangeable');
  assert.ok(find({ home: 'man city', away: 'arsenal', kickoff: new Date(Date.parse('2026-10-20T19:00:00Z') + 35.9 * 3600000).toISOString() }));
  assert.equal(find({ home: 'man city', away: 'arsenal', kickoff: new Date(Date.parse('2026-10-20T19:00:00Z') + 36.1 * 3600000).toISOString() }), null);
  assert.equal(find({ home: 'chelsea', away: 'man city', kickoff: '2026-10-20T19:00:00.000Z' }), null);

  assert.equal(createExtrasMatcher({ extras: null, resolver, universe })({ home: 'x', away: 'y', kickoff: '2026-10-20T19:00:00Z' }), null);
  assert.equal(createExtrasMatcher({ extras: { fixtures: [], injuries: [] }, resolver, universe })({ home: 'chelsea', away: 'arsenal', kickoff: '2026-10-20T19:00:00Z' }), null);
});

test('extras matcher: of two fixtures of the same pairing the nearer one in time wins (return leg a week later)', () => {
  const resolver = createResolver({});
  const universe = new Set(['arsenal', 'chelsea']);
  const mk = (id, kickoff) => ({ id, kickoff, status: 'NS', home: { name: 'Arsenal' }, away: { name: 'Chelsea' }, referee: `ref ${id}` });
  const find = createExtrasMatcher({ extras: { fixtures: [mk(1, '2026-10-20T19:00:00.000Z'), mk(2, '2026-10-21T10:00:00.000Z')], injuries: [] }, resolver, universe });
  assert.equal(find({ home: 'arsenal', away: 'chelsea', kickoff: '2026-10-20T19:30:00.000Z' }).apiId, 1);
  assert.equal(find({ home: 'arsenal', away: 'chelsea', kickoff: '2026-10-21T09:00:00.000Z' }).apiId, 2);
});
