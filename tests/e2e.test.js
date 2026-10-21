// End-to-end: the whole refresh pipeline against local mock servers.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildWorld, startMockServer, PROMOTED_2627 } from './mock-world.js';

const TOKEN = 'test-token';
const world = buildWorld();
const server = await startMockServer(world);
process.env.FD_ORG_BASE = `${server.url}/v4`;
process.env.FD_CSV_BASE = `${server.url}/mmz4281`;
process.env.ELO_BASE = server.url;
process.env.FD_ORG_MIN_INTERVAL_MS = '0';
process.env.CSV_PAUSE_MS = '0';
process.env.HTTP_BACKOFF_MS = '0';
const { runRefresh } = await import('../src/pipeline/refresh.js');
after(() => server.close());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const NOW = new Date('2026-10-18T10:00:00Z');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `fp-${label}-`));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));

function capture() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { log: push, error: push, warn: push, lines };
}

function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const state = {};

test('fresh run: PL is modelled, names matched, warnings listed', async () => {
  const outDir = tmp('out1');
  const logger = capture();
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: TOKEN },
    prevDir: tmp('empty'),
    outDir,
    aliasesPath: ALIASES,
    now: NOW,
    logger,
    only: ['PL'],
  });
  state.out1 = outDir;
  state.log1 = logger.lines.join('\n');
  assert.equal(res.exitCode, 0);

  const index = readJson(outDir, 'index.json');
  assert.equal(index.leagues.length, 1);
  assert.equal(index.leagues[0].status, 'ok');
  assert.equal(index.leagues[0].fixtures, 10);
  assert.equal(index.leagues[0].matches, 9);
  assert.equal(index.sources.footballDataOrg.status, 'ok');
  assert.equal(index.sources.clubElo.status, 'ok');
  const unmatched = index.warnings.filter((w) => w.code === 'unmatched-team');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].team, 'Zzyzx United FC');

  const pl = readJson(outDir, 'PL.json');
  assert.equal(pl.stale, false);
  assert.equal(pl.matches.length, 9);
  assert.ok(pl.params.converged);
  assert.ok(pl.params.rho <= 0.1 && pl.params.rho >= -0.25);
  assert.ok(pl.params.eta > 0.05 && pl.params.eta < 0.5, `eta ${pl.params.eta}`);
  assert.ok(pl.params.corners && pl.params.yellows);

  // sorted by kick-off, inside the 7-day window, none from the unmatched fixture
  const kicks = pl.matches.map((m) => m.kickoff);
  assert.deepEqual([...kicks].sort(), kicks);
  assert.ok(pl.matches.every((m) => new Date(m.kickoff) > NOW && new Date(m.kickoff) < new Date(NOW.getTime() + 7 * 86400000)));
  assert.ok(!pl.matches.some((m) => m.homeName === 'Zzyzx' || m.awayName === 'Zzyzx'));

  for (const m of pl.matches) {
    const g = m.goals;
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} vs ${b}`);
    near(g.oneX2.home + g.oneX2.draw + g.oneX2.away, 1);
    near(g.btts.yes + g.btts.no, 1);
    near(g.exactTotals.reduce((s, v) => s + v, 0), 1);
    for (const t of m.corners.totals) near(t.over + t.under, 1);
    for (const t of m.cards.totals) near(t.over + t.under, 1);
    assert.ok(m.model.lam > 0.3 && m.model.lam < 4 && m.model.mu > 0.3 && m.model.mu < 4);
    assert.ok(m.corners.mean.total > 6 && m.corners.mean.total < 14);
    assert.ok(m.cards.mean.total > 2 && m.cards.mean.total < 7);
    assert.match(m.analysis.text, /Νίκη/);
    assert.equal(m.analysis.source, 'template');
  }

  // promoted teams: Ipswich / Leicester / Southampton were not in the 2025/26 table
  const byAway = (name) => pl.matches.find((m) => m.awayName === name || m.homeName === name);
  const newcastleIpswich = byAway('Ipswich Town');
  assert.equal(newcastleIpswich.flags.promotedAway, true);
  assert.equal(newcastleIpswich.flags.promotedHome, false);
  for (const k of PROMOTED_2627.map((n) => n.toLowerCase())) assert.equal(pl.teams[k].promoted, true, k);
  assert.equal(pl.teams.arsenal.promoted, false);

  // a club known only to ClubElo is matched through the Elo universe: prior-only, low confidence
  const cov = pl.matches.find((m) => m.awayName === 'Coventry');
  assert.ok(cov, 'Coventry fixture present');
  assert.equal(cov.flags.promotedAway, true);
  assert.equal(cov.flags.fewDataAway, true);
  assert.equal(cov.flags.lowConfidence, true);
  assert.equal(pl.teams.coventry.elo, 1640);

  // scorers: previous season restricted (403) -> still works with G1 = 0
  const first = pl.matches[0];
  assert.ok(first.scorers.home.length > 0);
  assert.ok(first.scorers.home[0].anytime > 0 && first.scorers.home[0].anytime < 1);
  assert.match(first.scorers.home[0].name, /Striker/);
  assert.match(pl.notes.scorers, /συνθέσεις/);
  assert.ok(index.warnings.some((w) => w.code === 'scorers-restricted'));

  // referee known for the first fixture -> factor recorded (CSV has "M Oliver")
  assert.ok(first.cards.refereeFactor === null || typeof first.cards.refereeFactor === 'number');
});

test('no secret ever reaches the logs or the published files', () => {
  assert.ok(!state.log1.includes(TOKEN));
  for (const f of allFiles(state.out1)) {
    const raw = fs.readFileSync(f);
    const text = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    assert.ok(!text.includes(TOKEN), `${f} contains the token`);
  }
  assert.match(state.log1, /\[sample\] football-data\.org fixture/);
  assert.match(state.log1, /SUMMARY/);
  assert.match(state.log1, /lambda range/);
});

test('cache files are written next to the JSON', () => {
  const files = allFiles(state.out1).map((f) => path.relative(state.out1, f));
  assert.ok(files.includes('index.json'));
  assert.ok(files.includes('PL.json'));
  assert.ok(files.includes(path.join('cache', 'elo.json.gz')));
  assert.ok(files.includes(path.join('cache', 'csv-E0-2425.json.gz')));
  assert.ok(files.includes(path.join('cache', 'scorers-PL-2026.json.gz')));
});

test('second run reuses caches: completed seasons, Elo and scorers are not downloaded again', async () => {
  const before = server.hits.length;
  const outDir = tmp('out2');
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: TOKEN },
    prevDir: state.out1,
    outDir,
    aliasesPath: ALIASES,
    now: new Date(NOW.getTime() + 3 * 3600000),
    logger: capture(),
    only: ['PL'],
  });
  assert.equal(res.exitCode, 0);
  const newHits = server.hits.slice(before);
  assert.ok(!newHits.some((h) => /mmz4281\/(2324|2425|2526)/.test(h)), `completed seasons re-downloaded: ${newHits}`);
  assert.ok(newHits.some((h) => /mmz4281\/2627/.test(h)), 'current season is fetched every run');
  assert.ok(!newHits.some((h) => /^\/\d{4}-\d{2}-\d{2}/.test(h)), 'Elo cached');
  assert.ok(!newHits.some((h) => h.includes('/scorers')), 'scorers cached for 24 h');
  assert.ok(newHits.some((h) => h.includes('/matches')), 'fixtures always fetched');
  state.out2 = outDir;
});

test('fixtures source down: last good JSON is kept and marked stale', async () => {
  server.set({ fixturesStatus: 500 });
  const outDir = tmp('out3');
  const logger = capture();
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: TOKEN },
    prevDir: state.out2,
    outDir,
    aliasesPath: ALIASES,
    now: new Date(NOW.getTime() + 6 * 3600000),
    logger,
    only: ['PL'],
  });
  server.set({ fixturesStatus: 200 });
  assert.equal(res.exitCode, 1, 'nothing fresh -> non-zero exit, but files are still written');
  const prev = readJson(state.out2, 'PL.json');
  const kept = readJson(outDir, 'PL.json');
  assert.equal(kept.stale, true);
  assert.match(kept.staleReason, /500|upstream|HTTP/);
  assert.equal(kept.updatedAt, prev.updatedAt, 'data age is preserved, not refreshed');
  assert.deepEqual(kept.matches, prev.matches, 'no invented data');
  const index = readJson(outDir, 'index.json');
  assert.equal(index.leagues[0].status, 'stale');
  assert.equal(index.leagues[0].updatedAt, prev.updatedAt);
  assert.ok(index.warnings.some((w) => w.code === 'league-failed'));
  assert.match(logger.lines.join('\n'), /stale \(last good data kept\)/);
});

test('current-season CSV down but cached: model runs and is marked stale', async () => {
  server.set({ csvCurrentStatus: 500 });
  const outDir = tmp('out4');
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: TOKEN },
    prevDir: state.out2,
    outDir,
    aliasesPath: ALIASES,
    now: new Date(NOW.getTime() + 3.5 * 3600000), // 13:30 UTC: the 14:00 fixture has not kicked off yet
    logger: capture(),
    only: ['PL'],
  });
  server.set({ csvCurrentStatus: 200 });
  assert.equal(res.exitCode, 1, 'stale data do not count as a fresh league');
  const pl = readJson(outDir, 'PL.json');
  assert.equal(pl.stale, true);
  assert.match(pl.staleReason, /cache/);
  assert.equal(pl.matches.length, 9, 'fresh fixtures were still predicted');
  const index = readJson(outDir, 'index.json');
  assert.equal(index.sources.footballDataCoUk.status, 'stale');
});

test('no token at all: previous data survive as stale, nothing is invented', async () => {
  const outDir = tmp('out5');
  const res = await runRefresh({
    env: {},
    prevDir: state.out2,
    outDir,
    aliasesPath: ALIASES,
    now: new Date(NOW.getTime() + 9 * 3600000),
    logger: capture(),
    only: ['PL'],
  });
  assert.equal(res.exitCode, 1);
  const kept = readJson(outDir, 'PL.json');
  assert.equal(kept.stale, true);
  assert.match(kept.staleReason, /FOOTBALL_DATA_TOKEN/);
  assert.equal(readJson(outDir, 'index.json').sources.footballDataOrg.status, 'error');
});

test('first ever run with a dead fixtures source: error entry, no file, no crash', async () => {
  server.set({ fixturesStatus: 500 });
  const outDir = tmp('out6');
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: TOKEN },
    prevDir: tmp('empty2'),
    outDir,
    aliasesPath: ALIASES,
    now: NOW,
    logger: capture(),
    only: ['PL'],
  });
  server.set({ fixturesStatus: 200 });
  assert.equal(res.exitCode, 1);
  const index = readJson(outDir, 'index.json');
  assert.equal(index.leagues[0].status, 'error');
  assert.equal(index.leagues[0].file, null);
  assert.ok(!fs.existsSync(path.join(outDir, 'PL.json')));
});
