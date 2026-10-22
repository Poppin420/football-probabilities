import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildWorld3, startMockServer3, NOW3 } from './mock-world3.js';

delete process.env.ELO_SOURCE;
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
const { parseNewCsv } = await import('../src/sources/footballDataCoUk.js');
after(() => server.close());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const tmp = (l) => fs.mkdtempSync(path.join(os.tmpdir(), `fpx-${l}-`));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const readCache = (dir, name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'cache', `${name}.json.gz`))).toString('utf8'));
const quiet = { log() {}, error() {}, warn() {} };
const defaults = { eloStatus: 500, eloMonthly: 500 };

const HEADER = 'Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PH,PD,PA';
function austria() {
  const rows = [HEADER];
  const teams = ['Red Bull Salzburg', 'Sturm Graz', 'LASK', 'Rapid Wien'];
  for (let i = 0; i < 80; i++) {
    const d = new Date(NOW3.getTime() - (10 + i * 7) * 86400000);
    const dd = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
    const h = teams[i % 4];
    const a = teams[(i + 1 + (i % 3)) % 4];
    if (h === a) continue;
    rows.push(`Austria,Bundesliga,2025/2026,${dd},17:00,${h},${a},${i % 4},${i % 3},H,2.1,3.4,3.6`);
  }
  rows.push('Austria,Bundesliga,2026/2027,01/12/2099,17:00,LASK,Rapid Wien,,,,2.1,3.4,3.6'); // not played: no result
  return rows.join('\n');
}

test('new-leagues file: columns are read by name, odds are ignored, rows without a result or a date are dropped', () => {
  const r = parseNewCsv(`${HEADER}\nAustria,Bundesliga,2025/2026,19/07/2025,17:00,LASK,Sturm Graz,2,1,H,2,3,4\nAustria,Bundesliga,2025/2026,20/07/2025,17:00,A,B,,,,2,3,4\nAustria,Bundesliga,2025/2026,bad,17:00,A,B,1,1,D,2,3,4\n`, { file: 'AUT' });
  assert.equal(r.rows.length, 1);
  assert.deepEqual([r.rows[0].home, r.rows[0].away, r.rows[0].x, r.rows[0].y, r.rows[0].date], ['LASK', 'Sturm Graz', 2, 1, '2025-07-19']);
  assert.equal(r.noResult, 1);
  assert.equal(r.skipped, 1);
  const moved = parseNewCsv('AG,HG,Away,Home,Date\n0,3,B,A,01/08/2025\n', { file: 'X' });
  assert.deepEqual([moved.rows[0].home, moved.rows[0].x, moved.rows[0].y], ['A', 3, 0]);
  assert.throws(() => parseNewCsv('Date,Team1,Team2,S1,S2\n01/08/2025,a,b,1,0\n', { file: 'AUT' }), /header lacks home, away, hg, ag/);
});

async function refresh(prev, now = NOW3) {
  const out = tmp('out');
  const res = await runRefresh({ env: { FOOTBALL_DATA_TOKEN: 'test-token' }, prevDir: prev ?? tmp('empty'), outDir: out, aliasesPath: ALIASES, now, logger: quiet, only: ['CL'] });
  return { res, out, index: readJson(out, 'index.json') };
}

test('extra countries: a missing file is a warning only; a served file adds the matches to our own Elo and is cached for the day', async () => {
  server.set({ ...defaults, newCsv: {} });
  const a = await refresh();
  assert.equal(a.res.exitCode, 0);
  assert.equal(a.index.leagues.find((l) => l.code === 'CL').status, 'ok');
  assert.equal(a.index.warnings.filter((w) => w.code === 'extra-league-unavailable').length, 5);
  const base = Number(/^(\d+) matches/.exec(a.index.sources.ownElo.detail)[1]);

  server.set({ ...defaults, newCsv: { AUT: austria() } });
  const hits0 = server.state.newHits || 0;
  const b = await refresh();
  assert.equal(b.res.exitCode, 0);
  assert.deepEqual(b.index.warnings.filter((w) => w.code === 'extra-league-unavailable').map((w) => w.league).sort(), ['DNK', 'NOR', 'POL', 'SWZ']);
  const withAut = Number(/^(\d+) matches/.exec(b.index.sources.ownElo.detail)[1]);
  assert.ok(withAut >= base + 70, `own Elo matches ${base} -> ${withAut}`);
  const cached = readCache(b.out, 'csvnew-AUT');
  assert.ok(cached.rows.length >= 70 && cached.rows.every((r) => Number.isInteger(r.x)));

  // an hour later: the copy is reused, nothing is downloaded for Austria
  server.set({ ...defaults, newCsv: { AUT: austria() } });
  const mid = server.state.newHits;
  const c = await refresh(b.out, new Date(NOW3.getTime() + 3600000));
  assert.equal(c.res.exitCode, 0);
  assert.equal(readCache(c.out, 'csvnew-AUT').rows.length, cached.rows.length);
  assert.ok(server.state.newHits - mid <= 4, 'only the countries without a copy are asked again');
  assert.ok(hits0 >= 0);

  // a day later the source is gone: the old copy keeps the country in the ratings
  server.set({ ...defaults, newCsv: {} });
  const d = await refresh(c.out, new Date(NOW3.getTime() + 30 * 3600000));
  assert.equal(d.res.exitCode, 0);
  assert.ok(!d.index.warnings.some((w) => w.code === 'extra-league-unavailable' && w.league === 'AUT'));
  assert.equal(readCache(d.out, 'csvnew-AUT').rows.length, cached.rows.length);
});
