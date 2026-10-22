// A richer synthetic world for the Phase 3 tests: eight domestic leagues whose goals follow the Elo-only
// model exactly (so the pooled regression has a known truth), a Champions League with fixtures, results
// and scorers, and an API-Football mock (referees, injuries, plan errors, rate headers).
//
// It extends the Premier League world of mock-world.js: that world's own routes stay, this file adds
// the others through the `extra` hook of startMockServer().

import { mulberry32, normal, poissonSample } from './helpers.js';
import { buildWorld, startMockServer, CORE } from './mock-world.js';

/** The truth behind the generated goals: lam = exp(c + eta + kappa*dE/800), mu = exp(c - kappa*dE/800). */
export const TRUTH = Object.freeze({ kappa: 0.9, c: 0.12, eta: 0.25, cupShift: 0.18, halfShare: 0.45 });
const ELO_DIV = 800;
export const NOW3 = new Date('2026-10-18T10:00:00Z');

const ADJ = ['Amber', 'Azure', 'Bright', 'Crimson', 'Dusty', 'Emerald', 'Frosty', 'Golden', 'Hollow', 'Iron', 'Jade', 'Kindly', 'Lunar', 'Misty'];
const NOUN = ['Falcons', 'Wolves', 'Rovers', 'Giants', 'Pilots', 'Hornets', 'Sailors', 'Miners'];
// the seven domestic leagues besides the Premier League (whose goals come from mock-world.js)
export const DOMESTIC = [
  { code: 'ELC', div: 'E1', country: 'ENG', level: 2 },
  { code: 'BL1', div: 'D1', country: 'GER', level: 1 },
  { code: 'SA', div: 'I1', country: 'ITA', level: 1 },
  { code: 'PD', div: 'SP1', country: 'ESP', level: 1 },
  { code: 'FL1', div: 'F1', country: 'FRA', level: 1 },
  { code: 'DED', div: 'N1', country: 'NED', level: 1 },
  { code: 'PPL', div: 'P1', country: 'POR', level: 1 },
];
const SEASONS = ['2324', '2425', '2526', '2627'];
const HEADER = 'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A';

const fmtDate = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

function schedule(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) round.push(r % 2 === 0 ? [idx[i], idx[n - 1 - i]] : [idx[n - 1 - i], idx[i]]);
    rounds.push(round);
    idx.splice(1, 0, idx.pop());
  }
  return [...rounds, ...rounds.map((rd) => rd.map(([h, a]) => [a, h]))];
}

const PL_CSV_TO_ELO = { "Nott'm Forest": 'Forest' }; // the spellings of ClubElo where they differ from the CSV
const PL_CSV_TO_API = { 'Man United': 'Manchester United', 'Man City': 'Manchester City', "Nott'm Forest": 'Nottingham Forest' };

/**
 * @param {{seed?:number}} [opts]
 * @returns the PL world of mock-world.js (as `base`) plus csv3, eloText, clubs, cl, fixtures, results,
 *          scorers, API-Football fixtures (clApi, plApi) and injuries
 */
export function buildWorld3({ seed = 303 } = {}) {
  const base = buildWorld();
  const rand = mulberry32(seed);
  const htRand = mulberry32(seed + 1);

  // --- clubs and their Elo -------------------------------------------------------------
  const clubs = []; // { name, elo, country, level, league, fdName, short }
  const leagueClubs = new Map();
  DOMESTIC.forEach((lg, l) => {
    const list = [];
    ADJ.forEach((adj) => {
      const z = Math.max(-2, Math.min(2, normal(rand)));
      const club = { name: `${adj} ${NOUN[l]}`, elo: Math.round(1650 + 130 * z), country: lg.country, level: lg.level, league: lg.code };
      club.fdName = `${club.name} FC`;
      club.short = club.name;
      list.push(club);
      clubs.push(club);
    });
    leagueClubs.set(lg.code, list);
  });

  // Premier League: Elo consistent with the generating model of that league (E = 400 * Q / kappa, Q = att - def)
  const plExtra = [['Ipswich', 'Ipswich Town FC', 'Ipswich Town'], ['Leicester', 'Leicester City FC', 'Leicester City'], ['Southampton', 'Southampton FC', 'Southampton']];
  const plClubs = [...CORE, ...plExtra].map(([csv, fdName, short]) => {
    const st = base.strength.get(csv);
    const q = st ? st.att - st.def : 0;
    return { csv, name: PL_CSV_TO_ELO[csv] || csv, fdName, short, country: 'ENG', level: 1, elo: Math.round(1750 + (400 * q) / TRUTH.kappa), league: 'PL' };
  });
  const foreign = [
    { name: 'Salzburg', fdName: 'FC Red Bull Salzburg', short: 'Salzburg', apiName: 'Red Bull Salzburg', country: 'AUT', elo: 1680, level: 1 },
    { name: 'Celtic', fdName: 'Celtic FC', short: 'Celtic', country: 'SCO', elo: 1650, level: 1 },
    { name: 'Galatasaray', fdName: 'Galatasaray SK', short: 'Galatasaray', country: 'TUR', elo: 1660, level: 1 },
    { name: 'Olympiakos', fdName: 'Olympiacos FC', short: 'Olympiacos', apiName: 'Olympiacos', country: 'GRE', elo: 1640, level: 1 },
  ];

  const eloRows = [
    ...clubs.map((c) => [c.name, c.country, c.level, c.elo]),
    ...plClubs.map((c) => [c.name, c.country, c.level, c.elo]),
    ...foreign.map((c) => [c.name, c.country, c.level, c.elo]),
    ['Coventry', 'ENG', 2, 1640],
    ['Bayern', 'GER', 1, 2000],
  ];
  const eloCsv = (rows) => ['Rank,Club,Country,Level,Elo,From,To', ...rows.map((r, i) => `${i + 1},${r[0]},${r[1]},${r[2]},${r[3]},2020-01-01,2030-01-01`)].join('\n') + '\n';
  const eloText = eloCsv(eloRows);
  // a list that rates only the English and the foreign clubs: far too few domestic matches have both ratings
  const eloTextFew = eloCsv([...plClubs, ...foreign].map((c) => [c.name, c.country, c.level, c.elo]));
  const eloOf = new Map(eloRows.map((r) => [r[0], r[3]]));

  // --- domestic CSVs: goals from the Elo-only model, exactly --------------------------------------
  const halfGoals = (n) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (htRand() < TRUTH.halfShare) k++;
    return k;
  };
  const csv3 = {};
  for (const lg of DOMESTIC) {
    csv3[lg.div] = {};
    const teams = leagueClubs.get(lg.code);
    const rounds = schedule(teams.length);
    for (const code of SEASONS) {
      const startYear = 2000 + Number(code.slice(0, 2));
      const lastRound = code === '2627' ? 9 : rounds.length;
      const lines = [HEADER];
      for (let r = 0; r < lastRound; r++) {
        const date = new Date(Date.UTC(startYear, 7, 10 + 7 * r));
        for (const [h, a] of rounds[r]) {
          const d = (teams[h].elo - teams[a].elo) / ELO_DIV;
          const x = poissonSample(rand, Math.exp(TRUTH.c + TRUTH.eta + TRUTH.kappa * d));
          const y = poissonSample(rand, Math.exp(TRUTH.c - TRUTH.kappa * d));
          const hth = halfGoals(x);
          const hta = halfGoals(y);
          const res = x > y ? 'H' : x < y ? 'A' : 'D';
          const htr = hth > hta ? 'H' : hth < hta ? 'A' : 'D';
          lines.push(`${lg.div},${fmtDate(date)},15:00,${teams[h].name},${teams[a].name},${x},${y},${res},${hth},${hta},${htr},R Ref,10,9,4,3,11,12,5,4,2,2,0,0,2.1,3.4,3.6`);
        }
      }
      csv3[lg.div][code] = lines.join('\n') + '\n';
    }
  }

  // --- Champions League -------------------------------------------------------------------------------
  const topOf = (code, n) => leagueClubs.get(code).slice().sort((a, b) => b.elo - a.elo).slice(0, n);
  const plPick = (csv) => plClubs.find((c) => c.csv === csv);
  const cl = [
    plPick('Arsenal'), plPick('Man City'), plPick('Liverpool'), // 0-2
    ...topOf('BL1', 2), ...topOf('SA', 2), ...topOf('PD', 2), ...topOf('FL1', 2), // 3-10
    ...foreign, // 11-14
  ];
  const clId = new Map(cl.map((c, i) => [c.name, 500 + i]));
  const team = (c) => ({ id: clId.get(c.name), name: c.fdName, shortName: c.short, tla: c.name.slice(0, 3).toUpperCase() });
  const eloNow = (c) => eloOf.get(c.name);

  const clResult = (id, iso, h, a, stage, matchday, { duration = 'REGULAR', noRegularTime = false, season = 2026 } = {}) => {
    const d = (eloNow(h) - eloNow(a)) / ELO_DIV;
    const neutral = stage === 'FINAL';
    const x = poissonSample(rand, Math.exp(TRUTH.c + TRUTH.cupShift + (neutral ? 0 : TRUTH.eta) + TRUTH.kappa * d));
    const y = poissonSample(rand, Math.exp(TRUTH.c + TRUTH.cupShift - TRUTH.kappa * d));
    const score = { winner: x > y ? 'HOME_TEAM' : x < y ? 'AWAY_TEAM' : 'DRAW', duration, fullTime: { home: x, away: y }, halfTime: { home: halfGoals(x), away: halfGoals(y) } };
    if (duration !== 'REGULAR') {
      // football-data.org adds the extra-time goals to fullTime; the 90-minute score is in regularTime
      if (!noRegularTime) score.regularTime = { home: x, away: y };
      score.extraTime = { home: 1, away: 0 };
      score.fullTime = { home: x + 1, away: y };
      score.winner = 'HOME_TEAM';
    }
    return { id, utcDate: iso, status: 'FINISHED', matchday, stage, season: { id: season }, homeTeam: team(h), awayTeam: team(a), score, referees: [] };
  };
  const makePairs = (n, offset) =>
    Array.from({ length: n }, (_, i) => {
      const h = (i * 4 + offset) % cl.length; // 4 is coprime with 15: every club hosts
      const a = (h + 1 + ((i * 7) % 13)) % cl.length;
      return [cl[h], cl[a]];
    });
  let rid = 880000;
  const day = (y, m, d) => new Date(Date.UTC(y, m, d, 19)).toISOString();
  const currentResults = makePairs(24, 1).map(([h, a], i) => clResult(rid++, day(2026, 8, 16 + i), h, a, 'LEAGUE_STAGE', 1 + Math.floor(i / 12)));
  const previousResults = makePairs(60, 2).map(([h, a], i) => {
    const ko = i >= 40;
    // two ties went to extra time, one to penalties without a 90-minute score in the feed
    const opts = { season: 2025, duration: i === 45 || i === 50 ? 'EXTRA_TIME' : i === 55 ? 'PENALTY_SHOOTOUT' : 'REGULAR', noRegularTime: i === 55 };
    return clResult(rid++, day(2025, 8, 16 + 4 * i), h, a, ko ? 'LAST_16' : 'LEAGUE_STAGE', 1 + (i % 8), opts);
  });

  const kicks = ['2026-10-20T19:00:00Z', '2026-10-20T19:00:00Z', '2026-10-20T19:00:00Z', '2026-10-21T19:00:00Z', '2026-10-21T19:00:00Z', '2026-10-21T19:00:00Z', '2026-10-22T19:00:00Z'];
  const fixturePairs = [
    [cl[0], cl[3]], // Arsenal - first German club (injured striker at home, doubtful winger away)
    [cl[5], cl[1]], // first Italian club - Man City (suspended striker away)
    [cl[2], cl[14]], // Liverpool - Olympiacos (spelling differs between the sources)
    [cl[7], cl[11]],
    [cl[12], cl[9]],
    [cl[13], cl[4]],
    [cl[6], cl[8]],
  ];
  let fid = 770000;
  const fixtures = fixturePairs.map(([h, a], i) => ({
    id: fid++, utcDate: kicks[i], status: 'TIMED', matchday: 3, stage: 'LEAGUE_STAGE', homeTeam: team(h), awayTeam: team(a),
    score: { winner: null, fullTime: { home: null, away: null } }, referees: [],
  }));
  const finalFixture = { id: fid++, utcDate: '2026-10-23T19:00:00Z', status: 'TIMED', matchday: null, stage: 'FINAL', homeTeam: team(cl[0]), awayTeam: team(cl[1]), referees: [] };
  fixtures.push(finalFixture); // neutral ground
  fixtures.push({ id: fid++, utcDate: '2026-10-21T19:00:00Z', status: 'TIMED', matchday: 3, stage: 'LEAGUE_STAGE', homeTeam: { id: 990, name: 'Zzyzx FC', shortName: 'Zzyzx', tla: 'ZZY' }, awayTeam: team(cl[2]), referees: [] }); // unknown club
  fixtures.push({ id: fid++, utcDate: '2026-11-04T19:00:00Z', status: 'TIMED', matchday: 4, stage: 'LEAGUE_STAGE', homeTeam: team(cl[3]), awayTeam: team(cl[4]), referees: [] }); // outside the 7 days

  const scorers = (goals) =>
    cl.flatMap((c, i) => [
      { player: { id: 5000 + i * 2, name: `${c.short} Striker` }, team: team(c), playedMatches: 4, goals, assists: 1, penalties: 0 },
      { player: { id: 5001 + i * 2, name: `${c.short} Winger` }, team: team(c), playedMatches: 4, goals: Math.max(1, goals - 2), assists: 1, penalties: 0 },
    ]);

  // --- API-Football (v3 shapes) -------------------------------------------------------------------------
  const apiTeam = (name, id) => ({ id, name, logo: 'x' });
  const apiFixture = (id, iso, home, away, referee) => ({
    fixture: { id, referee, timezone: 'UTC', date: iso.replace('Z', '+00:00'), timestamp: Math.floor(Date.parse(iso) / 1000), status: { long: 'Not Started', short: 'NS', elapsed: null } },
    league: { id: 0, name: 'x', season: 2026 },
    teams: { home: apiTeam(home, 1), away: apiTeam(away, 2) },
    goals: { home: null, away: null },
  });
  const apiName = (c) => c.apiName || PL_CSV_TO_API[c.csv] || c.name;
  const clApi = [
    ...fixturePairs.map(([h, a], i) => apiFixture(7000 + i, kicks[i], apiName(h), apiName(a), null)),
    apiFixture(7007, finalFixture.utcDate, apiName(cl[0]), apiName(cl[1]), null),
  ];
  const csvOf = (t) => [...CORE, ...plExtra].find((c) => c[1] === t.name)?.[0];
  const plApi = base.fixtures.slice(0, 8).map((f, i) => {
    const h = csvOf(f.homeTeam);
    const a = csvOf(f.awayTeam);
    // Liverpool - Man City has no referee at football-data.org but one at API-Football
    return apiFixture(9000 + i, f.utcDate, PL_CSV_TO_API[h] || h, PL_CSV_TO_API[a] || a, i === 1 ? 'Anthony Taylor, England' : null);
  });

  const injuryRow = (fixtureId, teamName, teamId, playerName, type, reason, iso) => ({
    player: { id: teamId * 10, name: playerName, photo: 'x', type, reason },
    team: { id: teamId, name: teamName, logo: 'x' },
    fixture: { id: fixtureId, timezone: 'UTC', date: iso, timestamp: Math.floor(Date.parse(iso) / 1000) },
    league: { id: 2, season: 2026, name: 'x', country: 'World' },
  });
  const injuries = new Map(); // fixture id -> rows
  const put = (row) => {
    if (!injuries.has(row.fixture.id)) injuries.set(row.fixture.id, []);
    injuries.get(row.fixture.id).push(row);
  };
  const initial = (c) => c.short.slice(0, 1);
  put(injuryRow(7000, apiName(fixturePairs[0][0]), 11, `${initial(fixturePairs[0][0])}. Striker`, 'Missing Fixture', 'Knee Injury', clApi[0].fixture.date));
  put(injuryRow(7000, apiName(fixturePairs[0][1]), 12, `${initial(fixturePairs[0][1])}. Winger`, 'Questionable', 'Knock', clApi[0].fixture.date));
  put(injuryRow(7001, apiName(fixturePairs[1][1]), 13, `${initial(fixturePairs[1][1])}. Striker`, 'Missing Fixture', 'Red Card', clApi[1].fixture.date));
  put(injuryRow(9000, 'Arsenal', 42, 'A. Striker', 'Missing Fixture', 'Thigh Injury', plApi[0].fixture.date));
  // a player who is not in any scorer list and a record of a kind the tool ignores
  put(injuryRow(7002, apiName(fixturePairs[2][0]), 14, 'J. Nobody', 'Missing Fixture', 'Illness', clApi[2].fixture.date));
  put(injuryRow(7002, apiName(fixturePairs[2][1]), 15, 'O. Ignored', 'Something Else', 'Rest', clApi[2].fixture.date));

  return { base, csv3, eloText, eloTextFew, clubs, plClubs, foreign, cl, fixturePairs, fixtures, currentResults, previousResults, scorersCurrent: scorers(4), scorersPrevious: scorers(8), clApi, plApi, injuries };
}

/**
 * Start the combined server. Behaviour (server.set):
 *   apif: 'ok' | 'plan' | 'quota' | 'rate1' | 'down'      apifRemaining: account requests left at the start (header)
 *   el: 'ok' (default: the Europa League source serves the Champions League data under another name; the key must be 'rapid-test') | 'down'
 *   clFixtures / clResults: 'ok' | 500                    clPrevious: 'ok' | 403 (previous season restricted)
 *   eloStatus: daily ClubElo snapshot status (200 | 500)  eloMonthly: 'ok' | 500 (snapshots of the first of a month)
 *   eloSubset: 'few' -> ClubElo rates only the English and the foreign clubs
 * `server.state` counts the API-Football requests: reset `state.apifCalls` between scenarios.
 */
export async function startMockServer3(world3, initial = {}) {
  const state = { apifCalls: 0, rateErrors: 0, apifLog: [], apifKeys: [] };
  const handle = (req, url, send, behaviour) => {
    const p = url.pathname;
    const answer = (...args) => {
      send(...args);
      return true;
    };
    let m;
    // ClubElo: the same ratings on every date
    if (/^\/\d{4}-\d{2}-\d{2}$/.test(p)) {
      const monthly = p.endsWith('-01');
      if (monthly && behaviour.eloMonthly === 500) return answer(500, 'down', 'text/plain');
      if (!monthly && behaviour.eloStatus !== 200) return answer(behaviour.eloStatus, 'down', 'text/plain');
      return answer(200, behaviour.eloSubset === 'few' ? world3.eloTextFew : world3.eloText, 'text/csv');
    }
    if ((m = /^\/mmz4281\/(\d{4})\/([A-Z0-9]+)\.csv$/.exec(p)) && m[2] !== 'E0') {
      const text = world3.csv3[m[2]]?.[m[1]];
      if (!text) return answer(404, 'not found', 'text/plain');
      return answer(200, Buffer.from(text, 'latin1'), 'text/csv');
    }
    if (p === '/rapid/matches') {
      // the Europa League source (RapidAPI listing): the Champions League data under another name
      if (req.headers['x-rapidapi-key'] !== 'rapid-test' || !req.headers['x-rapidapi-host']) return answer(403, { message: 'You are not subscribed to this API.' });
      if (behaviour.el === 'down') return answer(500, { error: { code: 'internal', message: 'down' } });
      state.rapidCalls = (state.rapidCalls || 0) + 1;
      const team = (t) => ({ id: t.id, slug: null, name: t.name, shortName: t.shortName, code: t.tla, crestUrl: 'x' });
      const asRapid = (x, status, withScore) => ({ id: 880000 + x.id, competition: 'uefa-europa-league', season: '2026-27', stage: x.stage === 'LEAGUE_STAGE' ? 'League phase' : x.stage, round: x.matchday ?? null, kickoff: x.utcDate, status, minute: null, homeTeam: team(x.homeTeam), awayTeam: team(x.awayTeam), score: withScore ? { home: x.score?.fullTime?.home ?? null, away: x.score?.fullTime?.away ?? null } : { home: null, away: null }, venue: null });
      const season = url.searchParams.get('season');
      const finished = url.searchParams.get('status') === 'finished';
      const list = finished ? (season === '2026-27' ? world3.currentResults : world3.previousResults).map((x) => asRapid(x, 'finished', true)) : world3.fixtures.map((x) => asRapid(x, 'scheduled', false));
      return answer(200, { data: list, meta: { season: season || '2026-27', page: 1, limit: 200, total: list.length } }, 'application/json', { 'x-ratelimit-requests-remaining': '480', 'x-ratelimit-requests-limit': '500' });
    }
    if ((m = /^\/v4\/competitions\/(CL|EL)\/(matches|scorers|teams)$/.exec(p))) {
      if (req.headers['x-auth-token'] !== 'test-token') return answer(403, { message: 'bad token' });
      if (m[1] === 'EL') return answer(403, { message: 'The resource you are looking for is restricted and apparently not within your permissions.' });
      m = [m[0], m[2]];
      const hdr = { 'x-requests-available-minute': '9', 'x-requestcounter-reset': '60' };
      const season = url.searchParams.get('season');
      if (m[1] === 'teams') {
        // every club that appears in this season's fixtures or results
        const byId = new Map();
        for (const x of [...world3.fixtures, ...world3.currentResults]) for (const t of [x.homeTeam, x.awayTeam]) byId.set(t.id, t);
        const list = [...byId.values()];
        return answer(200, { count: list.length, competition: { code: 'CL' }, teams: list }, 'application/json', hdr);
      }
      if (m[1] === 'matches') {
        if (url.searchParams.get('status') === 'FINISHED') {
          if (behaviour.clResults === 500) return answer(500, { message: 'upstream down' });
          if (season === '2025' && behaviour.clPrevious === 403) return answer(403, { message: 'restricted' });
          const list = season === '2026' ? world3.currentResults : world3.previousResults;
          return answer(200, { filters: {}, resultSet: { count: list.length }, competition: { code: 'CL' }, matches: list }, 'application/json', hdr);
        }
        if (behaviour.clFixtures === 500) return answer(500, { message: 'upstream down' });
        return answer(200, { filters: {}, resultSet: { count: world3.fixtures.length }, competition: { code: 'CL' }, matches: world3.fixtures }, 'application/json', hdr);
      }
      if (season === '2025' && behaviour.clPrevious === 403) return answer(403, { message: 'restricted' });
      const list = season === '2026' ? world3.scorersCurrent : world3.scorersPrevious;
      return answer(200, { count: list.length, filters: { season, limit: Number(url.searchParams.get('limit')) }, scorers: list }, 'application/json', hdr);
    }
    if (p === '/apif/fixtures' || p === '/apif/injuries') {
      state.apifCalls++;
      state.apifLog.push(p + url.search);
      state.apifKeys.push(req.headers['x-apisports-key']);
      const remaining = Math.max(0, (behaviour.apifRemaining ?? 100) - state.apifCalls);
      const hdr = { 'x-ratelimit-requests-remaining': String(remaining), 'x-ratelimit-requests-limit': '100' };
      const body = (errors, response = [], extra = {}) => ({ get: p.slice(6), parameters: Object.fromEntries(url.searchParams), errors, results: response.length, paging: { current: 1, total: 1 }, response, ...extra });
      if (behaviour.apif === 'down') return answer(503, 'unavailable', 'text/plain', hdr);
      if (req.headers['x-apisports-key'] !== 'apif-test') {
        return answer(200, body({ token: 'Error/Missing application key. Go to https://www.api-football.com/documentation-v3 to learn how to get your API application key.' }), 'application/json', hdr);
      }
      if (behaviour.apif === 'plan') return answer(200, body({ plan: 'Free plans do not have access to this season, try from 2021 to 2023.' }), 'application/json', hdr);
      if (behaviour.apif === 'quota') return answer(200, body({ requests: 'You have reached the request limit for the day, Go to https://dashboard.api-football.com/ to upgrade your plan.' }), 'application/json', hdr);
      if (behaviour.apif === 'rate1' && state.rateErrors < 1) {
        state.rateErrors++;
        return answer(200, body({ rateLimit: 'Too many requests. Your rate limit is 10 requests per minute.' }), 'application/json', hdr);
      }
      if (p === '/apif/fixtures') {
        const league = url.searchParams.get('league');
        const list = league === '2' ? world3.clApi : league === '39' ? world3.plApi : [];
        return answer(200, body([], list), 'application/json', hdr);
      }
      const ids = (url.searchParams.get('ids') || '').split('-').map(Number);
      if (ids.length > 20) return answer(200, body({ ids: 'The Ids field must contain a maximum of 20 fixtures ids.' }), 'application/json', hdr);
      return answer(200, body([], ids.flatMap((id) => world3.injuries.get(id) || [])), 'application/json', hdr);
    }
    return false;
  };
  const server = await startMockServer(world3.base, { apif: 'ok', apifRemaining: 100, eloMonthly: 'ok', clFixtures: 'ok', clResults: 'ok', clPrevious: 'ok', el: 'ok', ...initial }, handle);
  return { ...server, state };
}
