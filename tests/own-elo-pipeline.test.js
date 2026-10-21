// Own Elo (the default): the daily refresh without any ClubElo download, the cross-check when ClubElo answers,
// the "fewer than 6 matches" rule of the Champions League and the weekly tuning with our own ratings.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildWorld3, startMockServer3, NOW3 } from './mock-world3.js';

delete process.env.ELO_SOURCE;
const TOKEN = 'test-token';
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
const { runTune } = await import('../src/pipeline/tune.js');
after(() => server.close());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `fpo-${label}-`));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const readCache = (dir, name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'cache', `${name}.json.gz`))).toString('utf8'));
const writeCache = (dir, name, value) => {
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cache', `${name}.json.gz`), zlib.gzipSync(Buffer.from(JSON.stringify(value))));
};
const quiet = { log() {}, error() {}, warn() {} };
const defaults = { eloStatus: 200, eloMonthly: 'ok', eloSubset: undefined };

async function refresh({ prev = null, elo = 'up', extra = {} } = {}) {
  server.set({ ...defaults, eloStatus: elo === 'up' ? 200 : 500, eloMonthly: elo === 'up' ? 'ok' : 500 });
  const outDir = tmp('out');
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn() {} };
  const before = server.hits.length;
  const res = await runRefresh({ env: { FOOTBALL_DATA_TOKEN: TOKEN }, prevDir: prev ?? tmp('empty'), outDir, aliasesPath: ALIASES, now: NOW3, logger, only: ['CL'], ...extra });
  return { res, outDir, log: lines.join('\n'), index: readJson(outDir, 'index.json'), cl: fs.existsSync(path.join(outDir, 'CL.json')) ? readJson(outDir, 'CL.json') : null, hits: server.hits.slice(before) };
}

const S = {};

test('ClubElo down: the Champions League is produced from our own Elo', async () => {
  const r = await refresh({ elo: 'down' });
  S.down = r;
  assert.equal(r.res.exitCode, 0);
  const entry = r.index.leagues.find((l) => l.code === 'CL');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.matches, 8);
  assert.equal(r.index.sources.ownElo.status, 'ok');
  assert.equal(r.index.sources.clubElo.status, 'error');
  assert.equal(r.index.elo.source, 'own');
  assert.equal(r.index.elo.check.status, 'unavailable');
  assert.ok(r.index.elo.cupMatches >= 80, `cup matches ${r.index.elo.cupMatches}`);
  assert.equal(r.cl.params.eloOnly.eloSource, 'own');
  assert.equal(r.cl.sources.elo.source, 'own');
  assert.match(r.cl.notes.eloOnly, /υπολογίζουμε οι ίδιοι/);
  assert.ok(!/clubelo/i.test(r.cl.notes.eloOnly));
  assert.ok(r.cl.params.eloOnly.converged);
  // no monthly ClubElo download at all: only the one daily probe
  const monthly = r.hits.filter((h) => /\/\d{4}-\d{2}-01(\?|$)/.test(String(h.path ?? h.url ?? h)));
  assert.equal(monthly.length, 0, 'no monthly ClubElo snapshot is requested');
  assert.ok(!r.index.warnings.some((w) => w.code === 'elo-partial'));
  assert.match(r.log, /\[own Elo\] \d+ matches, \d+ clubs/);
});

test('ClubElo up: only a cross-check, the probabilities are identical to the run without it', async () => {
  const up = await refresh({ elo: 'up' });
  S.up = up;
  const c = up.index.elo.check;
  assert.equal(c.status, 'ok');
  assert.ok(c.n >= 50, `common clubs ${c.n}`);
  assert.ok(c.correlation > 0.3 && c.correlation <= 1, `correlation ${c.correlation}`);
  assert.ok(c.meanAbsDiff >= 0);
  assert.equal(up.index.sources.clubElo.status, 'ok');
  assert.deepEqual(up.cl.matches.map((m) => [m.id, m.goals]), S.down.cl.matches.map((m) => [m.id, m.goals]));
  assert.deepEqual(up.cl.params.eloOnly.kappa, S.down.cl.params.eloOnly.kappa);
});

test('a ClubElo cross-check that is slower than the time limit is dropped and the run goes on', async () => {
  const t0 = Date.now();
  const r = await refresh({ elo: 'down', extra: { eloCheckMs: 50 } });
  assert.equal(r.res.exitCode, 0);
  assert.ok(Date.now() - t0 < 20000);
});

test('ELO_SOURCE=clubelo keeps the old behaviour: no own Elo, ClubElo downloaded', async () => {
  const r = await refresh({ elo: 'up', extra: { eloSource: 'clubelo' } });
  assert.equal(r.index.elo.source, 'clubelo');
  assert.equal(r.index.sources.ownElo.status, 'off');
  assert.equal(r.cl.sources.elo.source, 'clubelo');
  assert.match(r.cl.notes.eloOnly, /clubelo\.com/);
});

test('a club with fewer than 6 matches in the history: its fixture is skipped with a warning', async () => {
  const prev = tmp('thin');
  const cached = readCache(S.down.outDir, 'cup-results-CL-2026');
  const club = (t) => (/Salzburg/.test(`${t.name} ${t.shortName}`) ? 'Salzburg' : t.shortName);
  const results = cached.results.filter((r) => club(r.home) !== 'Salzburg' && club(r.away) !== 'Salzburg');
  const salz = cached.results.filter((r) => club(r.home) === 'Salzburg' || club(r.away) === 'Salzburg').slice(0, 3);
  assert.ok(salz.length > 0, 'the mock world has Champions League matches of Salzburg');
  writeCache(prev, 'cup-results-CL-2026', { ...cached, results: [...results, ...salz] });
  // the older seasons: no match of this club at all (the mock serves the same "previous" list for every older season)
  for (const y of [2025, 2024, 2023, 2022, 2021]) {
    const older = readCache(S.down.outDir, 'cup-results-CL-2025');
    writeCache(prev, `cup-results-CL-${y}`, { ...older, results: older.results.filter((r) => club(r.home) !== 'Salzburg' && club(r.away) !== 'Salzburg') });
  }
  const r = await refresh({ prev, elo: 'down' });
  const thin = r.index.warnings.filter((w) => w.code === 'thin-history');
  const hadSalzburg = S.down.cl.matches.some((m) => /Salzburg/.test(m.homeName + m.awayName));
  if (hadSalzburg) {
    assert.ok(thin.length >= 1, JSON.stringify(r.index.warnings.map((w) => w.code)));
    assert.match(thin[0].message, /Salzburg/);
    assert.ok(r.cl.matches.length < S.down.cl.matches.length);
    assert.ok(!r.cl.matches.some((m) => /Salzburg/.test(m.homeName + m.awayName)));
  } else {
    assert.equal(thin.length, 0);
  }
});

async function tuneWith(elo) {
  // the daily refresh fills the cache the tuning reads (CSV seasons, Champions League results)
  if (!S.daily) {
    server.set({ ...defaults, eloStatus: 500, eloMonthly: 500 });
    S.daily = tmp('daily');
    await runRefresh({ env: { FOOTBALL_DATA_TOKEN: TOKEN }, prevDir: tmp('e'), outDir: S.daily, aliasesPath: ALIASES, now: NOW3, logger: quiet, only: ['PL'] });
  }
  server.set({ ...defaults, eloStatus: elo === 'up' ? 200 : 500, eloMonthly: elo === 'up' ? 'ok' : 500 });
  const before = server.hits.length;
  const out = tmp('tune');
  const res = await runTune({ prevDir: S.daily, outDir: out, aliasesPath: ALIASES, now: NOW3, logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, eloProbeMs: 2000, eloOnlyMinRows: 100 });
  return { res, report: readJson(out, 'report.json'), hits: server.hits.slice(before) };
}

test('weekly tuning with our own Elo (ClubElo down): no snapshots are downloaded, the Elo prior is evaluated', async () => {
  const { res, report, hits } = await tuneWith('down');
  assert.equal(report.elo.source, 'own');
  assert.ok(report.elo.have > 10, `snapshots ${report.elo.have}`);
  assert.equal(report.elo.failed, 0);
  assert.ok(report.leagues.PL.elo.applied > 0, 'the Elo prior was fitted in the back-test');
  assert.equal(hits.filter((h) => /\/\d{4}-\d{2}-01(\?|$)/.test(String(h.path ?? h.url ?? h))).length, 0, 'no monthly ClubElo snapshot is requested');
  assert.equal(report.eloOnly.source, 'own');
  assert.equal(report.eloOnly.alt.status, 'unavailable');
  assert.ok(!res.warnings.some((w) => w.code === 'clubelo-better'));
});

test('weekly tuning, ClubElo answering again: the same proxy test with its ratings is reported next to ours', async () => {
  const { report } = await tuneWith('up');
  const alt = report.eloOnly.alt;
  assert.equal(alt.status, 'ok');
  assert.ok(alt.n >= 100 && Number.isFinite(alt.rps) && Number.isFinite(alt.ownRps), JSON.stringify(alt));
  assert.ok(['own', 'clubelo', 'equal'].includes(alt.better));
  assert.equal(report.eloOnly.source, 'own'); // the model itself keeps using ONE source
});
