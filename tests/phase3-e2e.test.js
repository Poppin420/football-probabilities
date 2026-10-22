// Phase 3 end-to-end: the whole refresh pipeline (Champions League Elo-only model, HT/FT markets,
// API-Football referees and injuries) against local mock servers.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildWorld3, startMockServer3, TRUTH, NOW3 } from './mock-world3.js';

// These tests exercise the downloaded-ClubElo path (the mock server serves ClubElo); the own-Elo path has its own tests.
process.env.ELO_SOURCE = 'clubelo';

const TOKEN = 'test-token';
const APIF_KEY = 'apif-test';
const world3 = buildWorld3();
const server = await startMockServer3(world3);
process.env.FD_ORG_BASE = `${server.url}/v4`;
process.env.FD_CSV_BASE = `${server.url}/mmz4281`;
process.env.ELO_BASE = server.url;
process.env.API_FOOTBALL_BASE = `${server.url}/apif`;
process.env.FD_ORG_MIN_INTERVAL_MS = '0';
process.env.CSV_PAUSE_MS = '0';
process.env.HTTP_BACKOFF_MS = '0';
process.env.API_FOOTBALL_MIN_INTERVAL_MS = '0';
process.env.API_FOOTBALL_RATE_WAIT_MS = '0';
const { runRefresh } = await import('../src/pipeline/refresh.js');
after(() => server.close());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const HOUR = 3600000;
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `fp3-${label}-`));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const readCache = (dir, name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'cache', `${name}.json.gz`))).toString('utf8'));
const writeCache = (dir, name, value) => {
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cache', `${name}.json.gz`), zlib.gzipSync(Buffer.from(JSON.stringify(value))));
};
const near = (a, b, tol = 1e-4, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b}`);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);

function capture() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { log: push, error: push, warn: push, lines };
}
function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const runs = []; // every run: its output folder and log, for the "no secret leaks" test at the end
const BOTH_KEYS = { FOOTBALL_DATA_TOKEN: TOKEN, API_FOOTBALL_KEY: APIF_KEY };

async function run({ prev = null, now = NOW3, env = BOTH_KEYS, only = ['CL'], behaviour = {} } = {}) {
  server.set(behaviour);
  const outDir = tmp('out');
  const logger = capture();
  const before = server.hits.length;
  const apifBefore = server.state.apifCalls;
  let res;
  try {
    res = await runRefresh({ env, prevDir: prev ?? tmp('empty'), outDir, aliasesPath: ALIASES, now, logger, only });
  } finally {
    server.set(Object.fromEntries(Object.keys(behaviour).map((k) => [k, server.state.behaviourDefaults[k]])));
  }
  const log = logger.lines.join('\n');
  runs.push({ outDir, log });
  return {
    res,
    outDir,
    log,
    index: readJson(outDir, 'index.json'),
    hits: server.hits.slice(before),
    apifRequests: server.state.apifCalls - apifBefore,
    league: (code) => (fs.existsSync(path.join(outDir, `${code}.json`)) ? readJson(outDir, `${code}.json`) : null),
  };
}

// the behaviour the server has when nothing special is asked for
server.state.behaviourDefaults = { apif: 'ok', apifRemaining: 100, eloMonthly: 'ok', eloStatus: 200, eloSubset: undefined, clFixtures: 'ok', clResults: 'ok', clPrevious: 'ok' };

const S = {}; // results shared by the sequential tests

// ---------------------------------------------------------------------------------------------------------------
test('CL fresh run: the Elo-only model is fitted on the pooled domestic matches', async () => {
  const r = await run();
  S.r1 = r;
  assert.equal(r.res.exitCode, 0);
  const { index } = r;
  assert.equal(index.phase, 3);
  assert.equal(index.leagues.length, 1);
  const entry = index.leagues[0];
  assert.equal(entry.code, 'CL');
  assert.equal(entry.eloOnly, true);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.fixtures, 9, '7 league-phase matches + the final + the unknown club; the match in November is outside the 7 days');
  assert.equal(entry.matches, 8);
  assert.equal(index.sources.clubElo.status, 'ok');
  assert.equal(index.sources.apiFootball.status, 'ok');

  const unmatched = index.warnings.filter((w) => w.code === 'unmatched-team');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].team, 'Zzyzx FC');
  assert.equal(unmatched[0].league, 'CL');
  assert.ok(Array.isArray(unmatched[0].closest));
  assert.ok(!index.warnings.some((w) => ['apif-no-match', 'elo-partial', 'htft-off', 'lambda-extreme', 'cup-results-failed'].includes(w.code)), JSON.stringify(index.warnings.map((w) => w.code)));

  const cl = r.league('CL');
  assert.equal(cl.schema, 1);
  assert.equal(cl.phase, 3);
  assert.equal(cl.stale, false);
  assert.equal(cl.league.eloOnly, true);
  const p = cl.params.eloOnly;
  assert.ok(p.converged);
  // the world generates goals with kappa 0.9, eta 0.25 and c 0.12 (the Premier League adds a little noise)
  assert.ok(Math.abs(p.kappa - TRUTH.kappa) < 0.15, `kappa ${p.kappa} (se ${p.kappaSe})`);
  assert.ok(Math.abs(p.eta - TRUTH.eta) < 0.07, `eta ${p.eta}`);
  assert.ok(Math.abs(p.cPooled - TRUTH.c) < 0.08, `cPooled ${p.cPooled}`);
  assert.ok(p.kappaSe > 0.02 && p.kappaSe < 0.15, `kappa se ${p.kappaSe}`);
  assert.ok(p.pooledMatches > 3000, `pooled matches ${p.pooledMatches}`);
  // the cup scores 0.18 more (in the log) than the domestic leagues: the shrunk intercept lies in between
  assert.ok(Math.abs(p.cCup - (TRUTH.c + TRUTH.cupShift)) < 0.15, `cCup ${p.cCup}`);
  assert.ok(p.cupWeight > 0.2 && p.cupWeight < 0.6, `cup weight ${p.cupWeight}`);
  near(p.c, p.cupWeight * p.cCup + (1 - p.cupWeight) * p.cPooled, 2e-6, 'shrinkage');
  assert.ok(p.c > p.cPooled && p.c < p.cCup);
  assert.equal(p.cupMatches, 83, '84 results, one penalty shoot-out without a 90-minute score');
  assert.equal(p.cupSkipped, 1);
  assert.ok(p.rho <= 0.1 && p.rho >= -0.25);
  assert.equal(p.eloDate, '2026-10-18');
  // half-time share of the pooled domestic leagues
  assert.ok(Math.abs(cl.params.halfShare.s - TRUTH.halfShare) < 0.03, `halfShare ${cl.params.halfShare.s}`);
  // the monthly snapshots: July 2024 - 2 months before ... October 2026
  assert.equal(cl.params.pool.snapshots, cl.params.pool.snapshotsWanted);
  assert.ok(cl.params.pool.snapshotsWanted >= 28);
  assert.deepEqual(Object.keys(cl.params.pool.leagues).sort(), ['BL1', 'DED', 'ELC', 'FL1', 'PD', 'PL', 'PPL', 'SA']);
  assert.ok(Object.values(cl.params.pool.leagues).every((n) => n > 300));
  // log line of the summary
  assert.match(r.log, /Elo-only: kappa [0-9.]+ ± [0-9.]+ \| c pooled/);
  assert.match(r.log, /\[sample\] football-data\.org CL result/);
});

test('CL matches: the formulas of the model, no corners / cards / ranges, the badge flag', () => {
  const cl = S.r1.league('CL');
  const e = cl.params.eloOnly;
  assert.equal(cl.matches.length, 8);
  const kicks = cl.matches.map((m) => m.kickoff);
  assert.deepEqual([...kicks].sort(), kicks);
  assert.ok(cl.matches.every((m) => new Date(m.kickoff) > NOW3 && new Date(m.kickoff) < new Date(NOW3.getTime() + 7 * 86400000)));
  assert.ok(!cl.matches.some((m) => /Zzyzx/.test(m.homeName + m.awayName)));

  for (const m of cl.matches) {
    assert.deepEqual(m.flags, { eloOnly: true });
    // corners / cards: only an estimate from the two clubs' domestic models, or nothing at all
    for (const c of [m.corners, m.cards]) {
      if (c === null) continue;
      assert.equal(c.estimate, true);
      assert.ok(Array.isArray(c.basis) && c.basis.length === 2);
    }
    assert.equal(m.ranges, null);
    const dE = m.elo.home - m.elo.away;
    const lam = Math.exp(e.c + (m.neutral ? 0 : e.eta) + (e.kappa * dE) / 800);
    const mu = Math.exp(e.c - (e.kappa * dE) / 800);
    near(m.model.lam, lam, 2e-4 * lam, `lam of ${m.homeName}`);
    near(m.model.mu, mu, 2e-4 * mu, `mu of ${m.awayName}`);

    const g = m.goals;
    near(g.oneX2.home + g.oneX2.draw + g.oneX2.away, 1);
    near(g.btts.yes + g.btts.no, 1);
    near(sum(g.exactTotals), 1);
    for (const t of g.totals) near(t.over + t.under, 1);
    assert.ok((g.oneX2.home - g.oneX2.away) * (m.model.lam - m.model.mu) > 0, 'the favourite of the model is the team with more expected goals');
    assert.match(m.analysis.text, /βαθμολογία Elo/);
    assert.match(m.analysis.text, /χαμηλότερη/);
    assert.equal(m.analysis.source, 'template');
  }

  // the final is played on neutral ground: no home advantage
  const fin = cl.matches.find((m) => m.stage === 'FINAL');
  assert.ok(fin);
  assert.equal(fin.neutral, true);
  near(Math.log(fin.model.lam * fin.model.mu), 2 * e.c, 1e-4);
  const regular = cl.matches.find((m) => m.stage === 'LEAGUE_STAGE');
  assert.equal(regular.neutral, false);
  near(Math.log(regular.model.lam * regular.model.mu), 2 * e.c + e.eta, 1e-4);

  // Elo ratings of the clubs come from the (today's) ClubElo list
  assert.equal(cl.teams.arsenal.elo, world3.cl[0].elo);
  assert.equal(cl.teams['man city'].elo, world3.cl[1].elo);
  assert.equal(cl.teams.arsenal.nEff, null);
  assert.ok(cl.notes.eloOnly.includes('Elo'));
});

test('CL half-time / full-time block: the full-time side equals the displayed 1X2', () => {
  const cl = S.r1.league('CL');
  for (const m of cl.matches) {
    const h = m.htft;
    assert.ok(h, 'htft present');
    assert.equal(h.combos.length, 9);
    near(sum(h.combos), 1);
    // order: 11, 1X, 12, X1, XX, X2, 21, 2X, 22  (half time first)
    const ft = [h.combos[0] + h.combos[3] + h.combos[6], h.combos[1] + h.combos[4] + h.combos[7], h.combos[2] + h.combos[5] + h.combos[8]];
    near(ft[0], m.goals.oneX2.home, 2e-5, 'FT home');
    near(ft[1], m.goals.oneX2.draw, 2e-5, 'FT draw');
    near(ft[2], m.goals.oneX2.away, 2e-5, 'FT away');
    near(h.ht.home, sum(h.combos.slice(0, 3)), 2e-5);
    near(h.ht.draw, sum(h.combos.slice(3, 6)), 2e-5);
    near(h.ht.away, sum(h.combos.slice(6, 9)), 2e-5);
    near(h.ht.home + h.ht.draw + h.ht.away, 1);
    assert.deepEqual(h.firstHalf.totals.map((t) => t.line), [0.5, 1.5, 2.5]);
    assert.ok(h.firstHalf.mean < m.goals.expected.total);
    assert.ok(h.s > 0.3 && h.s < 0.6);
  }
});

test('CL scorers: absent players leave the list, doubtful ones are tagged, unknown ones are ignored', () => {
  const cl = S.r1.league('CL');
  const byId = (id) => cl.matches.find((m) => m.id === id);
  const m0 = byId(770000); // Arsenal - first German club
  assert.equal(m0.scorers.absences.source, 'api-football');
  assert.deepEqual(m0.scorers.absences.home.map((p) => [p.name, p.kind]), [['Arsenal Striker', 'injury']]);
  assert.deepEqual(m0.scorers.absences.away, []);
  assert.ok(!m0.scorers.home.some((p) => p.name === 'Arsenal Striker'));
  assert.ok(m0.scorers.home.some((p) => p.name === 'Arsenal Winger'));
  const doubtful = m0.scorers.away.filter((p) => p.doubtful);
  assert.equal(doubtful.length, 1);
  assert.match(doubtful[0].name, /Winger$/);
  assert.equal(doubtful[0].kind, 'injury');
  assert.ok(doubtful[0].anytime > 0, 'a doubtful player stays in the list with his probability');

  const m1 = byId(770001); // first Italian club - Man City: the City striker is suspended
  assert.deepEqual(m1.scorers.absences.away.map((p) => [p.name, p.kind]), [['Man City Striker', 'suspension']]);
  assert.ok(!m1.scorers.away.some((p) => p.name === 'Man City Striker'));

  const m2 = byId(770002); // Liverpool - Olympiacos: a record for a player nobody lists + a record of an unknown kind
  assert.deepEqual(m2.scorers.absences.home, []);
  assert.deepEqual(m2.scorers.absences.away, []);
  assert.ok(m2.scorers.home.some((p) => p.name === 'Liverpool Striker'));

  const m3 = byId(770003); // beyond the 72 hours: no injuries were requested
  assert.equal(m3.scorers.absences, undefined);

  // a missing striker raises nobody's probability out of proportion: all values are probabilities
  for (const m of cl.matches) {
    for (const p of [...m.scorers.home, ...m.scorers.away]) {
      assert.ok(p.anytime > 0 && p.anytime < 1);
      assert.ok(p.twoPlus <= p.anytime && p.first <= p.anytime);
    }
  }
  assert.match(cl.notes.scorers, /Champions League/);
  assert.match(cl.notes.scorersAbsences, /API-Football/);
  assert.equal(cl.params.scorerPrior != null, true);
});

test('API-Football: two requests, the key only in the header, the counter and the extras in the cache', () => {
  const r = S.r1;
  assert.equal(r.apifRequests, 2);
  const [first, second] = server.state.apifLog.slice(-2);
  assert.equal(first, '/apif/fixtures?league=2&season=2026&from=2026-10-18&to=2026-10-26');
  assert.equal(second, '/apif/injuries?ids=7000-7001-7002', 'only the matches kicking off within 72 hours');
  assert.deepEqual(new Set(server.state.apifKeys.slice(-2)), new Set([APIF_KEY]));
  assert.ok(!r.hits.some((h) => h.includes(APIF_KEY)), 'the key is not in any URL');
  assert.match(r.index.sources.apiFootball.detail, /2 requests this run, 2 today, 98 left/);

  const usage = readCache(r.outDir, 'apif-usage');
  assert.deepEqual(usage, { day: '2026-10-18', calls: 2, disabled: null });
  const extras = readCache(r.outDir, 'apif-extras');
  assert.equal(extras.leagues.CL.fixtures.length, 8);
  assert.equal(extras.leagues.CL.injuries.length, 4, 'the record of an unknown type is ignored');
  assert.ok(extras.leagues.CL.injuries.every((i) => ['out', 'doubtful'].includes(i.state)));
  assert.equal(r.league('CL').sources.apiFootball.fixtures, 8);
  assert.equal(r.league('CL').sources.apiFootball.stale, false);
});

test('second run (PL + CL): snapshots and completed seasons are cached, PL gets referee, injuries and HT/FT', async () => {
  const r = await run({ prev: S.r1.outDir, now: new Date(NOW3.getTime() + 3 * HOUR), only: ['PL', 'CL'] });
  S.r2 = r;
  assert.equal(r.res.exitCode, 0);
  assert.deepEqual(r.index.leagues.map((l) => [l.code, l.status]), [['PL', 'ok'], ['CL', 'ok']]);
  assert.ok(!r.hits.some((h) => /^\/\d{4}-\d{2}-01$/.test(h)), `monthly snapshots downloaded again: ${r.hits.filter((h) => /^\/\d{4}-\d{2}-\d{2}$/.test(h))}`);
  assert.ok(!r.hits.some((h) => /mmz4281\/(2324|2425|2526)/.test(h)), 'completed seasons are cached');
  assert.ok(!r.hits.some((h) => /CL\/(scorers|matches\?.*FINISHED)/.test(h)), 'cup results and scorers are cached for a day');
  assert.ok(r.hits.some((h) => /CL\/matches\?.*status=SCHEDULED/.test(h)), 'fixtures are fetched every run');
  assert.equal(r.apifRequests, 3, 'PL fixtures, CL fixtures, one injuries call for both');
  assert.equal(server.state.apifLog.at(-1), '/apif/injuries?ids=9000-9001-9002-7000-7001-7002');
  assert.deepEqual(readCache(r.outDir, 'apif-usage'), { day: '2026-10-18', calls: 5, disabled: null }, 'the counter accumulates over the day');
  assert.ok(!r.index.warnings.some((w) => w.code === 'apif-no-match'), JSON.stringify(r.index.warnings));

  const pl = r.league('PL');
  assert.equal(pl.phase, 3);
  assert.equal(pl.stale, false);
  assert.ok(Math.abs(pl.params.halfShare.s - TRUTH.halfShare) < 0.03, `PL half share ${pl.params.halfShare.s}`);
  for (const m of pl.matches) {
    assert.ok(m.htft && m.htft.combos.length === 9);
    near(sum(m.htft.combos), 1);
    near(m.htft.combos[0] + m.htft.combos[3] + m.htft.combos[6], m.goals.oneX2.home, 2e-5);
  }

  // Arsenal - Chelsea: referee from football-data.org, the Arsenal striker is out
  const ac = pl.matches.find((m) => m.homeName === 'Arsenal' && m.awayName === 'Chelsea');
  assert.equal(ac.cards.referee.source, 'football-data.org');
  assert.deepEqual(ac.scorers.absences.home.map((p) => [p.name, p.kind]), [['Arsenal Striker', 'injury']]);
  assert.ok(!ac.scorers.home.some((p) => p.name === 'Arsenal Striker'));
  assert.ok(ac.scorers.home.length > 0 && ac.scorers.away.length > 0);

  // Liverpool - Man City has no referee at football-data.org: API-Football's "Name, Country" matches "A Taylor" of the CSVs
  const lm = pl.matches.find((m) => m.homeName === 'Liverpool' && m.awayName === 'Man City');
  assert.equal(lm.cards.referee.source, 'api-football');
  assert.equal(lm.cards.referee.name, 'Anthony Taylor', 'the ", Country" suffix of API-Football is dropped');
  assert.ok(lm.cards.referee.matches >= 5, `referee matches ${lm.cards.referee.matches}`);
  assert.equal(typeof lm.cards.referee.factor, 'number');
  assert.equal(lm.scorers.absences, undefined, 'no injury record for this fixture');

  // matches without any referee information stay as in Phase 2
  const mt = pl.matches.find((m) => m.homeName === 'Man United');
  assert.equal(mt.cards.referee, undefined);
  assert.equal(pl.sources.apiFootball.fixtures, 8);
  assert.ok(pl.sources.apiFootball.injuries >= 1);
  assert.equal(r.league('CL').matches.length, 8);
});

test('the daily API-Football budget is spent: no request, the extras of the previous run are reused and marked stale', async () => {
  const prev = tmp('budget');
  fs.cpSync(S.r2.outDir, prev, { recursive: true });
  writeCache(prev, 'apif-usage', { day: '2026-10-18', calls: 40, disabled: null });
  const r = await run({ prev, now: new Date(NOW3.getTime() + 5 * HOUR), only: ['CL'] });
  assert.equal(r.apifRequests, 0);
  assert.equal(r.res.exitCode, 0);
  assert.equal(r.index.sources.apiFootball.status, 'stale');
  assert.match(r.index.sources.apiFootball.detail, /daily budget of 40 requests used/);
  const cl = r.league('CL');
  assert.equal(cl.sources.apiFootball.stale, true);
  const m0 = cl.matches.find((m) => m.id === 770000);
  assert.deepEqual(m0.scorers.absences.home.map((p) => p.name), ['Arsenal Striker'], 'absences of the previous run are still applied');
  assert.deepEqual(readCache(r.outDir, 'apif-usage'), { day: '2026-10-18', calls: 40, disabled: null });
  assert.ok(!r.index.warnings.some((w) => w.code === 'apif-no-match'), 'no mismatch warning for reused extras');
});

test('extras of the previous run are reused for 30 hours when the API fails, not longer', async () => {
  // r2 fetched the extras at 13:00 on the 18th; the kick-offs of the CL matches are on the 20th
  const fresh = await run({ prev: S.r2.outDir, now: new Date(NOW3.getTime() + 3 * HOUR + 24 * HOUR), behaviour: { apif: 'down' } });
  assert.equal(fresh.index.sources.apiFootball.status, 'stale');
  assert.match(fresh.index.sources.apiFootball.detail, /previous run/);
  const m0 = fresh.league('CL').matches.find((m) => m.id === 770000);
  assert.deepEqual(m0.scorers.absences.home.map((p) => p.name), ['Arsenal Striker']);

  const old = await run({ prev: S.r2.outDir, now: new Date(NOW3.getTime() + 3 * HOUR + 31 * HOUR), behaviour: { apif: 'down' } });
  assert.equal(old.index.sources.apiFootball.status, 'error');
  const o0 = old.league('CL').matches.find((m) => m.id === 770000);
  assert.ok(o0, 'the fixture is still ahead');
  assert.equal(o0.scorers.absences, undefined, 'a 31-hour-old injury list is not applied');
});

test('a free plan without access to the season: the feature is switched off for hours, the page still works', async () => {
  const r = await run({ behaviour: { apif: 'plan' } });
  assert.equal(r.res.exitCode, 0);
  assert.equal(r.apifRequests, 1, 'one request is enough to learn it');
  assert.equal(r.index.sources.apiFootball.status, 'off');
  assert.match(r.index.sources.apiFootball.detail, /Free plans do not have access to this season/);
  assert.match(r.log, /\[API-Football\].*Free plans do not have access/);
  const cl = r.league('CL');
  assert.equal(cl.stale, false);
  assert.equal(cl.matches.length, 8);
  assert.ok(cl.matches.every((m) => m.scorers.absences === undefined));
  const usage = readCache(r.outDir, 'apif-usage');
  assert.equal(usage.calls, 1);
  assert.match(usage.disabled.reason, /Free plans do not have access/);
  assert.equal(usage.disabled.at, NOW3.toISOString());
  S.rPlan = r;

  // one hour later: still disabled, not a single request
  const r2 = await run({ prev: r.outDir, now: new Date(NOW3.getTime() + 1 * HOUR) });
  assert.equal(r2.apifRequests, 0);
  assert.equal(r2.index.sources.apiFootball.status, 'off');
  assert.match(r2.index.sources.apiFootball.detail, /disabled \(.*Free plans do not have access/);
  assert.equal(readCache(r2.outDir, 'apif-usage').disabled.at, NOW3.toISOString(), 'the mark keeps its original time');

  // six hours later the mark has expired: the API is asked again (and now answers)
  const r3 = await run({ prev: r2.outDir, now: new Date(NOW3.getTime() + 6 * HOUR) });
  assert.equal(r3.apifRequests, 2);
  assert.equal(r3.index.sources.apiFootball.status, 'ok');
  assert.equal(readCache(r3.outDir, 'apif-usage').disabled, null);
  assert.equal(readCache(r3.outDir, 'apif-usage').calls, 3);
});

test('without API_FOOTBALL_KEY: no request, status off, no absences', async () => {
  const r = await run({ env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 0);
  assert.equal(r.apifRequests, 0);
  assert.equal(r.index.sources.apiFootball.status, 'off');
  assert.match(r.index.sources.apiFootball.detail, /API_FOOTBALL_KEY is not set/);
  assert.equal(r.league('CL').sources.apiFootball, null);
  assert.ok(r.league('CL').matches.every((m) => m.scorers.absences === undefined));
});

test('a per-minute rate-limit answer is retried once', async () => {
  server.state.rateErrors = 0;
  const r = await run({ behaviour: { apif: 'rate1' } });
  assert.equal(r.index.sources.apiFootball.status, 'ok');
  assert.equal(r.apifRequests, 3, 'the refused request, the fixtures, the injuries');
  assert.equal(readCache(r.outDir, 'apif-usage').calls, 3, 'the refused request is counted');
  assert.ok(r.league('CL').matches.find((m) => m.id === 770000).scorers.absences);
  assert.match(r.log, /per-minute limit reached/);
});

test('API-Football down (HTTP 503): the run continues without extras and says why', async () => {
  const r = await run({ behaviour: { apif: 'down' } });
  assert.equal(r.res.exitCode, 0);
  assert.equal(r.index.sources.apiFootball.status, 'error');
  assert.ok(r.apifRequests >= 1);
  assert.ok(r.league('CL').matches.every((m) => m.scorers.absences === undefined));
});

test('the account runs low (fewer than 20 requests left): no injuries request is made', async () => {
  const r = await run({ behaviour: { apifRemaining: server.state.apifCalls + 20 } });
  assert.equal(r.apifRequests, 1, 'the fixtures request leaves 19, the reserve of 20 forbids the next one');
  assert.equal(r.index.sources.apiFootball.status, 'ok');
  assert.ok(r.league('CL').matches.every((m) => m.scorers.absences === undefined));
});

// ---------------------------------------------------------------------------------------------------------------
test('cup results unavailable: the pooled domestic intercept is used and a warning says so', async () => {
  const r = await run({ behaviour: { clResults: 500 }, env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 0);
  const p = r.league('CL').params.eloOnly;
  assert.equal(p.cCup, null);
  assert.equal(p.cupMatches, 0);
  assert.equal(p.cupWeight, 0);
  assert.equal(p.c, p.cPooled);
  assert.ok(r.index.warnings.some((w) => w.code === 'cup-results-failed'));
});

test('previous season restricted at football-data.org: the current season alone is used', async () => {
  const r = await run({ behaviour: { clPrevious: 403 }, env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 0);
  const cl = r.league('CL');
  assert.equal(cl.params.eloOnly.cupMatches, 24);
  assert.ok(cl.params.eloOnly.cupWeight < S.r1.league('CL').params.eloOnly.cupWeight);
  assert.ok(r.index.warnings.some((w) => w.code === 'scorers-restricted' && w.league === 'CL'));
  assert.equal(cl.matches.length, 8);
  assert.ok(cl.matches[0].scorers, 'scorers still work with last season unknown');
});

test('CL fixtures down: the last good CL.json is kept and marked stale', async () => {
  const r = await run({ prev: S.r1.outDir, behaviour: { clFixtures: 500 }, now: new Date(NOW3.getTime() + 4 * HOUR) });
  assert.equal(r.res.exitCode, 1, 'nothing fresh');
  const kept = r.league('CL');
  const before = S.r1.league('CL');
  assert.equal(kept.stale, true);
  assert.match(kept.staleReason, /500|upstream|HTTP/);
  assert.equal(kept.updatedAt, before.updatedAt);
  assert.deepEqual(kept.matches, before.matches, 'no invented data');
  assert.equal(r.index.leagues[0].status, 'stale');
  assert.equal(r.index.leagues[0].eloOnly, true);
  assert.ok(r.index.warnings.some((w) => w.code === 'league-failed' && w.league === 'CL'));
});

test('monthly ClubElo snapshots unavailable and not cached: CL fails alone, with a clear reason', async () => {
  const r = await run({ behaviour: { eloMonthly: 500 }, env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 1);
  assert.equal(r.index.leagues[0].status, 'error');
  assert.equal(r.index.leagues[0].file, null);
  assert.match(r.index.leagues[0].staleReason, /μηνιαία στιγμιότυπα ClubElo/);
  assert.equal(r.league('CL'), null);
});

test('monthly snapshots unavailable but the previous ones are cached: the run is unaffected', async () => {
  const r = await run({ prev: S.r1.outDir, behaviour: { eloMonthly: 500 }, now: new Date(NOW3.getTime() + 2 * HOUR), env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 0);
  assert.equal(r.index.leagues[0].status, 'ok');
  assert.ok(!r.index.warnings.some((w) => w.code === 'elo-partial'));
});

test('too few rated domestic matches: the Elo-only model refuses to fit', async () => {
  const r = await run({ behaviour: { eloSubset: 'few' }, env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 1);
  assert.equal(r.index.leagues[0].status, 'error');
  assert.match(r.index.leagues[0].staleReason, /Elo-only/);
  assert.equal(r.league('CL'), null);
});

test('no ClubElo at all: CL fails with a reason, nothing is invented', async () => {
  const r = await run({ behaviour: { eloStatus: 500 }, env: { FOOTBALL_DATA_TOKEN: TOKEN } });
  assert.equal(r.res.exitCode, 1);
  assert.equal(r.index.sources.clubElo.status, 'error');
  assert.equal(r.index.leagues[0].status, 'error');
  assert.match(r.index.leagues[0].staleReason, /ClubElo/);
});

test('no token: CL keeps its previous data as stale', async () => {
  const r = await run({ prev: S.r1.outDir, env: {}, now: new Date(NOW3.getTime() + 8 * HOUR) });
  assert.equal(r.res.exitCode, 1);
  const kept = r.league('CL');
  assert.equal(kept.stale, true);
  assert.match(kept.staleReason, /FOOTBALL_DATA_TOKEN/);
});

// ---------------------------------------------------------------------------------------------------------------
test('no secret ever reaches the logs or the published files', () => {
  assert.ok(runs.length >= 15);
  for (const { outDir, log } of runs) {
    for (const secret of [TOKEN, APIF_KEY]) assert.ok(!log.includes(secret), `${secret} in a log`);
    for (const f of allFiles(outDir)) {
      const raw = fs.readFileSync(f);
      const text = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      for (const secret of [TOKEN, APIF_KEY]) assert.ok(!text.includes(secret), `${f} contains a secret`);
    }
  }
});

test('the output of the first run is valid for the page: schema, keys, sizes', () => {
  const index = S.r1.index;
  assert.equal(index.schema, 1);
  for (const key of ['generatedAt', 'horizonDays', 'leagues', 'warnings', 'sources', 'ai', 'tune']) assert.ok(key in index, key);
  const files = allFiles(S.r1.outDir).map((f) => path.relative(S.r1.outDir, f));
  assert.ok(files.includes('CL.json'));
  assert.ok(files.includes(path.join('cache', 'apif-usage.json.gz')));
  assert.ok(files.includes(path.join('cache', 'apif-extras.json.gz')));
  assert.ok(files.includes(path.join('cache', 'cup-results-CL-2026.json.gz')));
  assert.ok(files.includes(path.join('cache', 'cup-results-CL-2025.json.gz')));
  assert.ok(files.includes(path.join('cache', 'scorers-CL-2026.json.gz')));
  assert.ok(files.filter((f) => /cache\/elo-\d{4}-\d{2}-01\.json\.gz$/.test(f)).length >= 28);
  assert.ok(fs.statSync(path.join(S.r1.outDir, 'CL.json')).size < 400000);
});
