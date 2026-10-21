// Phase 2: the weekly tuning + back-test job (search rule, tune.json / report.json,
// carry-over of the data branch, hand-over to the daily refresh).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildWorld, startMockServer } from './mock-world.js';
import { mulberry32, normal, poissonSample } from './helpers.js';

const world = buildWorld();
const server = await startMockServer(world);
process.env.FD_ORG_BASE = `${server.url}/v4`;
process.env.FD_CSV_BASE = `${server.url}/mmz4281`;
process.env.ELO_BASE = server.url;
process.env.FD_ORG_MIN_INTERVAL_MS = '0';
process.env.CSV_PAUSE_MS = '0';
process.env.HTTP_BACKOFF_MS = '0';
const { runRefresh } = await import('../src/pipeline/refresh.js');
const tuneMod = await import('../src/pipeline/tune.js');
const { chooseOneSe, coordinateSearch, halfFlags, monthStarts, runTune, MIN_HALF_MATCHES, MIN_SKILL } = tuneMod;
const { GRID, readTune, sanitizeParams, sanitizeCalibration, paramsFor } = await import('../src/pipeline/tuneFile.js');
const { keepCacheName } = await import('../src/pipeline/retention.js');
const { PHASE2_DEFAULTS } = await import('../src/model/goalsFit.js');
after(() => server.close());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const NOW = new Date('2026-10-19T03:37:00Z');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `fp-tune-${label}-`));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const quiet = { log() {}, error() {}, warn() {} };
const listAll = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/')).sort();
const readGz = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));

// ------------------------------------------------------------------ search rule --

const series = (values) => ({ mean: values.reduce((s, v) => s + v, 0) / values.length, series: values });

/**
 * Deterministic objective series: a shared base, a constant offset and a +-0.1 pattern on bit k of the match
 * index. Patterns of different candidates are orthogonal, so the paired standard error of any two candidates
 * is exactly 0.1 * sqrt(2 / (n - 1)) = 0.0063 for n = 512, and the mean difference is exactly the offset
 * difference.
 */
const SE = 0.1 * Math.sqrt(2 / 511);
const patterned = (k, offset, n = 512) => series(Array.from({ length: n }, (_, j) => 2 + 0.3 * ((j % 7) / 7) + offset + ((j >> k) & 1 ? 0.1 : -0.1)));
const candidates = (offsets) => GRID.xi.map((value, k) => ({ value, ...patterned(k, offsets[k]) }));

test('1-SE rule: keeps the default when it is within one standard error of the best', () => {
  const offsets = [0.004, 0.002, 0.003, 0, 0.0035]; // best = 0.0025; everything is closer than one SE
  assert.ok(Math.max(...offsets) < SE);
  assert.equal(chooseOneSe(candidates(offsets), 0.0019).value, 0.0019);
  // the same offsets, but the best is the default itself
  assert.equal(chooseOneSe(candidates([0.2, 0.2, 0, 0.2, 0.2]), 0.0019).value, 0.0019);
});

test('1-SE rule: leaves the default only when it is clearly worse, then takes the nearest value that is as good as the best', () => {
  // the default (0.0019) is 0.04 worse (6 SE); 0.0025 is 0.003 (< 1 SE) worse than the best 0.0035
  assert.equal(chooseOneSe(candidates([0.06, 0.05, 0.04, 0.003, 0]), 0.0019).value, 0.0025);
  // the best is far better than everything else: the best itself
  assert.equal(chooseOneSe(candidates([0.2, 0.15, 0.1, 0.05, 0]), 0.0019).value, 0.0035);
  // both neighbours of the default are as good as the best (same distance): the lower objective wins
  assert.equal(chooseOneSe(candidates([0.2, 0.002, 0.1, 0, 0.2]), 0.0019).value, 0.0025);
});

test('1-SE rule: identical objectives (a parameter without any effect) keep the default', () => {
  const same = GRID.om.map((value) => ({ value, ...series(Array.from({ length: 300 }, (_, j) => 1.5 + (j % 5) * 0.01)) }));
  assert.equal(chooseOneSe(same, 0.6).value, 0.6);
});

test('coordinate search: finds the optimum of each coordinate, starts from the defaults, skips Elo when it cannot be evaluated', () => {
  const rand = mulberry32(3);
  const noise = Array.from({ length: 800 }, () => 0.02 * (rand() - 0.5));
  // true optimum: xi 0.001, sigma 0.4, om 1, elo false; separable quadratic bowls
  const best = { xi: 0.001, sigma: 0.4, om: 1, elo: false };
  const calls = [];
  const evaluate = (p) => {
    calls.push(p);
    const idx = (list, v) => list.indexOf(v);
    const d = (idx(GRID.xi, p.xi) - idx(GRID.xi, best.xi)) ** 2 + (idx(GRID.sigma, p.sigma) - idx(GRID.sigma, best.sigma)) ** 2 + (idx(GRID.om, p.om) - idx(GRID.om, best.om)) ** 2 + (p.elo === best.elo ? 0 : 1);
    return series(noise.map((v) => 2.3 + 0.03 * d + v));
  };
  const res = coordinateSearch({ evaluate, withElo: true });
  assert.deepEqual(res.params, best);
  assert.ok(res.gain > 0.05, `gain ${res.gain}`);
  assert.ok(res.trail.length >= 4 && res.trail[0].coordinate === 'xi');
  assert.deepEqual(calls[0], { ...PHASE2_DEFAULTS, xi: 0.001 }, 'first candidate: default point with the first xi value');

  const noElo = coordinateSearch({ evaluate, withElo: false });
  assert.equal(noElo.params.elo, PHASE2_DEFAULTS.elo, 'Elo is left at the default when it is not evaluated');
  assert.ok(noElo.trail.every((t) => t.coordinate !== 'elo'));

  // a flat objective never moves away from the defaults
  const flat = coordinateSearch({ evaluate: () => series(noise.map((v) => 2.3 + v)) });
  assert.deepEqual(flat.params, { ...PHASE2_DEFAULTS });
  assert.equal(flat.gain, 0);
});

test('month starts: first day of every month from the month before the window to its end', async () => {
  const { dayNumberFromIso } = await import('../src/config.js');
  const dates = monthStarts(dayNumberFromIso('2024-08-10'), dayNumberFromIso('2024-11-20'));
  assert.deepEqual(dates, ['2024-07-01', '2024-08-01', '2024-09-01', '2024-10-01', '2024-11-01']);
  // a window that ends on the 1st still includes that day
  assert.equal(monthStarts(dayNumberFromIso('2025-01-15'), dayNumberFromIso('2025-03-01')).at(-1), '2025-03-01');
});

test('retention: older CSV seasons and recent monthly Elo snapshots are kept, the rest is pruned', () => {
  // now = 2026-10-19 -> current season 2026; tuning needs 2021/22 .. 2025/26
  assert.equal(keepCacheName('csv-E0-2122', NOW), true);
  assert.equal(keepCacheName('csv-E0-2021', NOW), false);
  assert.equal(keepCacheName('csv-SP1-2627', NOW), true);
  assert.equal(keepCacheName('elo-2024-06-01', NOW), true);
  assert.equal(keepCacheName('elo-2023-01-01', NOW), false);
  assert.equal(keepCacheName('elo', NOW), false, 'the daily Elo snapshot belongs to the refresh');
  assert.equal(keepCacheName('scorers-PL-2026', NOW), false);
});

// -------------------------------------------------------------------- tune.json --

test('tune.json: only grid values and bounded calibration numbers are accepted', () => {
  assert.deepEqual(sanitizeParams({ xi: 0.0025, sigma: 0.3, om: 0.8, elo: false }), { xi: 0.0025, sigma: 0.3, om: 0.8, elo: false });
  assert.equal(sanitizeParams({ xi: 0.002, sigma: 0.3, om: 0.8, elo: false }), null, 'xi is not a grid value');
  assert.equal(sanitizeParams({ xi: 0.0025, sigma: 0.3, om: 0.8 }), null);
  assert.equal(sanitizeParams(null), null);
  assert.deepEqual(sanitizeCalibration({ x12: { tau: 1.3, d: 1.1 }, ou25: null, btts: { a: 0, b: 0.7 } }), { x12: { tau: 1.3, d: 1.1 }, ou25: null, btts: { a: 0, b: 0.7 } });
  assert.equal(sanitizeCalibration({ x12: { tau: 9, d: 1 }, ou25: { a: 0, b: 40 }, btts: null }), null);
  assert.equal(sanitizeCalibration({ x12: { tau: 'x', d: 1 } }), null);
});

test('tune.json: missing file = defaults silently; broken or stale file = a warning, never a crash', () => {
  const dir = tmp('tunefile');
  const none = readTune(path.join(dir, 'tune.json'), NOW);
  assert.equal(none.found, false);
  assert.deepEqual(none.warnings, []);
  assert.deepEqual(paramsFor(none, 'PL'), { params: { ...PHASE2_DEFAULTS }, source: 'default' });

  fs.writeFileSync(path.join(dir, 'tune.json'), '{"schema":7}');
  assert.equal(readTune(path.join(dir, 'tune.json'), NOW).warnings[0].code, 'tune-invalid');

  fs.writeFileSync(
    path.join(dir, 'tune.json'),
    JSON.stringify({
      schema: 1,
      generatedAt: '2026-09-01T03:00:00Z',
      leagues: { PL: { params: { xi: 0.001, sigma: 0.3, om: 0.6, elo: true }, source: 'tuned' }, BL1: { params: { xi: 5, sigma: 1, om: 2, elo: 1 } } },
      calibration: { adopted: { x12: { tau: 1.2, d: 1.1 }, ou25: null, btts: null } },
    }),
  );
  const t = readTune(path.join(dir, 'tune.json'), NOW);
  assert.equal(t.found, true);
  assert.deepEqual(paramsFor(t, 'PL'), { params: { xi: 0.001, sigma: 0.3, om: 0.6, elo: true }, source: 'tuned' });
  assert.equal(paramsFor(t, 'BL1').source, 'default', 'illegal values are ignored');
  assert.deepEqual(t.calibration.x12, { tau: 1.2, d: 1.1 });
  assert.deepEqual(t.warnings.map((w) => w.code).sort(), ['tune-league-invalid', 'tune-stale']);
});

// ------------------------------------------------------------------ the whole job --

const state = {};

/** A previous "data" branch: a refresh run of the mock world. */
async function previousBranch() {
  const outDir = tmp('branch');
  const res = await runRefresh({ env: { FOOTBALL_DATA_TOKEN: 'test-token' }, prevDir: tmp('empty'), outDir, aliasesPath: ALIASES, now: new Date('2026-10-18T10:00:00Z'), logger: quiet, only: ['PL'] });
  assert.equal(res.exitCode, 0);
  return outDir;
}

test('no previous data: nothing to tune, nothing to publish, no error', async () => {
  const res = await runTune({ prevDir: tmp('nothing'), outDir: tmp('out'), aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'] });
  assert.equal(res.exitCode, 0);
  assert.equal(res.publish, false);
});

test('weekly run on the mock world: report, tune.json, everything else carried over', async () => {
  const prev = await previousBranch();
  fs.writeFileSync(path.join(prev, 'ai-cache.json'), JSON.stringify({ schema: 1, promptHash: 'x', entries: { k: { match: 'PL:1', kickoff: '2026-10-19T12:00:00Z', text: 'κείμενο' } } }));
  const eloHitsBefore = server.hits.filter((h) => /^\/\d{4}-\d{2}-\d{2}$/.test(h)).length;
  const outDir = tmp('out');
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')), warn: () => {} };
  const t0 = Date.now();
  const res = await runTune({ prevDir: prev, outDir, aliasesPath: ALIASES, now: NOW, logger, only: ['PL'], bootstrapK: 8, sleepFn: async () => {} });
  state.seconds = (Date.now() - t0) / 1000;
  state.prev = prev;
  state.out = outDir;
  state.eloHits = server.hits.filter((h) => /^\/\d{4}-\d{2}-\d{2}$/.test(h)).length - eloHitsBefore;
  state.lines = lines.join('\n');

  assert.equal(res.publish, true);
  const files = listAll(outDir);
  for (const f of ['PL.json', 'index.json', 'ai-cache.json', 'tune.json', 'report.json', 'cache/elo.json.gz']) assert.ok(files.includes(f), `${f} missing from ${files.join(', ')}`);
  assert.ok(files.some((f) => /^cache\/elo-\d{4}-\d{2}-01\.json\.gz$/.test(f)), 'monthly Elo snapshots are cached');
  assert.ok(files.includes('cache/csv-E0-2425.json.gz') && files.includes('cache/csv-E0-2526.json.gz'));
  // the daily files are byte-identical copies
  for (const f of ['PL.json', 'index.json', 'ai-cache.json']) assert.deepEqual(fs.readFileSync(path.join(outDir, f)), fs.readFileSync(path.join(prev, f)), `${f} must be carried over unchanged`);

  const tune = readJson(outDir, 'tune.json');
  assert.equal(tune.schema, 1);
  assert.equal(tune.generatedAt, NOW.toISOString());
  const pl = tune.leagues.PL;
  assert.ok(sanitizeParams(pl.params), `legal params: ${JSON.stringify(pl.params)}`);
  assert.ok(['tuned', 'default'].includes(pl.source));
  assert.equal(pl.matches >= 300, true);

  const report = readJson(outDir, 'report.json');
  assert.equal(report.schema, 1);
  assert.deepEqual(report.window.seasons, ['2024/25', '2025/26']);
  assert.equal(report.criteria.minSkill, MIN_SKILL);
  const r = report.leagues.PL;
  for (const k of ['matches', 'origins', 'params', 'tuning', 'metrics', 'skill', 'calibration', 'season', 'counts', 'ranges', 'elo', 'xg', 'flags']) assert.ok(k in r, `report.leagues.PL.${k}`);
  assert.equal(r.matches, pl.matches);
  for (const m of ['model', 'base', 'poisson', 'phase1']) {
    assert.ok(Number.isFinite(r.metrics[m].x12.rps) && Number.isFinite(r.metrics[m].ou25.logLoss) && Number.isFinite(r.metrics[m].btts.brier), m);
  }
  assert.ok(r.metrics.model.x12.rps < r.metrics.base.x12.rps, 'the model beats the league base rates');
  assert.ok(r.skill.vsBase.rps > 0);
  for (const k of ['home', 'draw', 'away', 'ou25', 'btts']) {
    // draw probabilities live in a narrow band, so only a few of the 10 equal-width bins are filled
    assert.ok(Array.isArray(r.calibration[k].bins) && r.calibration[k].bins.length >= (k === 'draw' ? 2 : 4), `${k}: ${r.calibration[k].bins.length} bins`);
    assert.ok(Number.isFinite(r.calibration[k].slope), k);
    for (const b of r.calibration[k].bins) assert.ok(b.n > 0 && b.p >= b.lo - 1e-9 && b.p <= b.hi + 1e-9 && b.f >= 0 && b.f <= 1, `${k} bin ${JSON.stringify(b)}`);
  }
  assert.ok(r.season.early.n > 30 && r.season.rest.n > 100);
  assert.ok(r.counts.corners.n > 500 && Number.isFinite(r.counts.corners.gain));
  assert.ok(r.counts.yellows.n > 500);
  assert.ok(r.ranges.meanWidth.home > 0.01 && r.ranges.meanWidth.home < 0.4);
  assert.ok(r.tuning.backtests >= 10 && Array.isArray(r.tuning.trail));
  assert.ok(report.pooled.matches === r.matches);
  assert.ok(report.calibrationLayer.markets.x12 && 'adopt' in report.calibrationLayer.markets.x12);
  // Elo: the monthly snapshots were downloaded once and the prior was evaluated
  assert.ok(report.elo.have > 15 && report.elo.failed === 0, JSON.stringify(report.elo));
  assert.equal(r.tuning.eloEvaluated, true);
  assert.ok(state.eloHits >= report.elo.have);
  // no Phase 1 / secret leak
  assert.ok(!JSON.stringify(report).includes('test-token'));
});

test('the second weekly run reuses every cached download (no CSV or Elo request)', async () => {
  const hitsBefore = server.hits.length;
  const outDir = tmp('out2');
  const res = await runTune({ prevDir: state.out, outDir, aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {} });
  assert.equal(res.publish, true);
  const newHits = server.hits.slice(hitsBefore).filter((h) => /mmz4281|^\/\d{4}-\d{2}-\d{2}$/.test(h));
  // only the seasons that do not exist in the mock (404) are asked again, never an Elo date or an existing season
  assert.deepEqual(newHits.filter((h) => /^\/\d{4}-\d{2}-\d{2}$/.test(h)), []);
  assert.deepEqual(newHits.filter((h) => /(2324|2425|2526)/.test(h)), []);
  assert.deepEqual(listAll(outDir).filter((f) => f.startsWith('cache/elo-')), listAll(state.out).filter((f) => f.startsWith('cache/elo-')));
});

test('hand-over: the daily refresh reads tune.json, uses its parameters and keeps tune.json / report.json / the Elo snapshots', async () => {
  // force a recognisable setting into tune.json
  const tuneFile = path.join(state.out, 'tune.json');
  const tune = readJson(tuneFile);
  tune.leagues.PL.params = { xi: 0.0025, sigma: 0.3, om: 0.8, elo: false };
  tune.leagues.PL.source = 'tuned';
  fs.writeFileSync(tuneFile, JSON.stringify(tune));
  const outDir = tmp('daily');
  const res = await runRefresh({ env: { FOOTBALL_DATA_TOKEN: 'test-token' }, prevDir: state.out, outDir, aliasesPath: ALIASES, now: new Date('2026-10-19T05:07:00Z'), logger: quiet, only: ['PL'] });
  assert.equal(res.exitCode, 0);
  const pl = readJson(outDir, 'PL.json');
  assert.equal(pl.params.xi, 0.0025);
  assert.equal(pl.params.sigma, 0.3);
  assert.equal(pl.params.om, 0.8);
  assert.equal(pl.params.eloPrior, null, 'elo:false in tune.json switches the Elo prior off');
  assert.equal(pl.params.tuned.source, 'tuned');
  assert.equal(pl.params.tuned.generatedAt, NOW.toISOString());
  const index = readJson(outDir, 'index.json');
  assert.equal(index.tune.found, true);
  const files = listAll(outDir);
  assert.ok(files.includes('tune.json') && files.includes('report.json'));
  assert.deepEqual(readJson(outDir, 'report.json'), readJson(state.out, 'report.json'));
  assert.equal(files.filter((f) => f.startsWith('cache/elo-')).length, listAll(state.out).filter((f) => f.startsWith('cache/elo-')).length, 'the monthly snapshots survive the daily commit');
  assert.ok(files.includes('cache/csv-E0-2526.json.gz'));
});

test('an adopted calibration in tune.json is applied to the published probabilities', async () => {
  const tuneFile = path.join(state.out, 'tune.json');
  const tune = readJson(tuneFile);
  tune.calibration = { adopted: { x12: { tau: 1.0, d: 1.3 }, ou25: null, btts: null } };
  fs.writeFileSync(tuneFile, JSON.stringify(tune));
  const withoutDir = tmp('nocal');
  const plain = await (async () => {
    const t2 = { ...tune, calibration: null };
    const d = tmp('prevplain');
    fs.cpSync(state.out, d, { recursive: true });
    fs.writeFileSync(path.join(d, 'tune.json'), JSON.stringify(t2));
    await runRefresh({ env: { FOOTBALL_DATA_TOKEN: 'test-token' }, prevDir: d, outDir: withoutDir, aliasesPath: ALIASES, now: new Date('2026-10-19T05:07:00Z'), logger: quiet, only: ['PL'] });
    return readJson(withoutDir, 'PL.json');
  })();
  const outDir = tmp('cal');
  await runRefresh({ env: { FOOTBALL_DATA_TOKEN: 'test-token' }, prevDir: state.out, outDir, aliasesPath: ALIASES, now: new Date('2026-10-19T05:07:00Z'), logger: quiet, only: ['PL'] });
  const cal = readJson(outDir, 'PL.json');
  assert.deepEqual(cal.params.calibration.x12, { tau: 1, d: 1.3 });
  assert.equal(plain.params.calibration, null);
  const draw = (j) => j.matches[0].goals.oneX2.draw;
  assert.ok(draw(cal) > draw(plain) + 0.01, `draw ${draw(plain)} -> ${draw(cal)}`);
  const sum = cal.matches[0].goals.oneX2;
  assert.ok(Math.abs(sum.home + sum.draw + sum.away - 1) < 1e-5);
});

/**
 * A synthetic league served through the injected fetchCsv (same row shape as the CSV parser):
 * team strengths with the given spread (0 = results do not depend on the teams at all).
 */
function syntheticCsv({ seed = 77, nTeams = 16, attSd = 0.4, defSd = 0.35, home = 0.25, halfShare = null } = {}) {
  const rand = mulberry32(seed);
  // half-time goals (Phase 3) come from their own stream, so the full-time numbers do not depend on `halfShare`
  const halfRand = mulberry32(seed + 1);
  const thin = (goals) => {
    let k = 0;
    for (let i = 0; i < goals; i++) if (halfRand() < halfShare) k++;
    return k;
  };
  const names = Array.from({ length: nTeams }, (_, i) => `Synth Team ${String.fromCharCode(65 + i)}`);
  const att = names.map(() => attSd * normal(rand));
  const def = names.map(() => defSd * normal(rand));
  const cache = new Map();
  const fetchCsv = async (_div, code) => {
    if (!cache.has(code)) {
      const y = 2000 + Number(code.slice(0, 2));
      const pairs = [];
      for (let h = 0; h < nTeams; h++) for (let a = 0; a < nTeams; a++) if (h !== a) pairs.push([h, a]);
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
      const day0 = Date.UTC(y, 7, 10) / 86400000;
      const rows = pairs.map(([h, a], k) => {
        const t = day0 + Math.floor((k / pairs.length) * 270);
        const fx = poissonSample(rand, Math.exp(0.1 + home + att[h] + def[a]));
        const fy = poissonSample(rand, Math.exp(0.1 + att[a] + def[h]));
        return {
          date: new Date(t * 86400000).toISOString().slice(0, 10),
          t,
          home: names[h],
          away: names[a],
          x: fx,
          y: fy,
          hthg: halfShare === null ? null : thin(fx),
          htag: halfShare === null ? null : thin(fy),
          hs: null, as: null, hst: null, ast: null, hc: null, ac: null, hy: null, ay: null, hr: null, ar: null, referee: null,
        };
      });
      cache.set(code, { missing: false, rows });
    }
    return cache.get(code);
  };
  // what a rating agency would know: the team names and a rating that follows their true quality
  fetchCsv.names = names;
  fetchCsv.quality = att.map((a, i) => a - def[i]);
  return fetchCsv;
}
const eloDown = async () => {
  throw new Error('ClubElo is down');
};

/** A copy of the "data" branch the weekly run produced, without its download cache. */
function branchWithoutCache() {
  const dir = tmp('nocache');
  fs.cpSync(state.out, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'cache'), { recursive: true, force: true });
  return dir;
}

test('a league with real team differences passes the 8 % limit (exit 0), pooled numbers match the league', async () => {
  const outDir = tmp('strong');
  const res = await runTune({ prevDir: branchWithoutCache(), outDir, aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'], bootstrapK: 6, sleepFn: async () => {}, fetchCsv: syntheticCsv(), fetchElo: eloDown });
  assert.equal(res.exitCode, 0, JSON.stringify(res.report.leagues.PL.skill));
  assert.equal(res.publish, true);
  const r = readJson(outDir, 'report.json');
  assert.ok(r.leagues.PL.skill.vsBase.rps >= MIN_SKILL, `skill ${r.leagues.PL.skill.vsBase.rps}`);
  assert.deepEqual(r.leagues.PL.flags, []);
  assert.deepEqual(r.pooled.flags, []);
  assert.equal(r.pooled.matches, r.leagues.PL.matches);
  assert.ok(Math.abs(r.pooled.skill.vsBase.rps - r.leagues.PL.skill.vsBase.rps) < 1e-9);
  // no Elo at all: the prior is neither evaluated nor switched off, and the week says so
  assert.equal(r.leagues.PL.tuning.eloEvaluated, false);
  assert.equal(readJson(outDir, 'tune.json').leagues.PL.params.elo, true);
  assert.ok(r.warnings.some((w) => w.code === 'elo-unavailable'));
  // nothing of the synthetic data is cached under a wrong name; the Elo failure is not cached
  const cached = listAll(outDir).filter((f) => f.startsWith('cache/'));
  assert.ok(cached.includes('cache/csv-E0-2526.json.gz') && !cached.some((f) => f.startsWith('cache/elo-')));
});

/** ClubElo for a synthetic league: every club, rated by its true quality (country ENG like the Premier League). */
const syntheticElo = (synth) => async (date) => ({
  date,
  clubs: synth.names.map((name, i) => ({ club: name, country: 'ENG', level: 1, elo: 1700 + 400 * synth.quality[i], rank: i + 1 })),
});

test('Elo-only model (Phase 3): the weekly report tests the Champions League formula on the domestic matches', async () => {
  const synth = syntheticCsv({ nTeams: 18 });
  const outDir = tmp('eloonly');
  const lines = [];
  const logger = { log: (m) => lines.push(String(m)), warn() {}, error() {} };
  const res = await runTune({ prevDir: branchWithoutCache(), outDir, aliasesPath: ALIASES, now: NOW, logger, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: synth, fetchElo: syntheticElo(synth), eloOnlyMinRows: 100 });
  assert.equal(res.exitCode, 0, 'a test of the cup formula never decides the exit code');
  const rep = readJson(outDir, 'report.json');
  const e = rep.eloOnly;
  assert.ok(e && !e.skipped, JSON.stringify(rep.warnings));
  assert.deepEqual(e.leagues, ['PL']);
  assert.ok(e.n >= 300 && e.n <= rep.leagues.PL.matches, `n ${e.n} of ${rep.leagues.PL.matches}`);
  assert.equal(e.n, e.scored, 'the league model scored the same matches: compared on exactly those');
  assert.ok(e.leagueModel && Number.isFinite(e.skill.vsLeagueModel.rps));
  // ratings that follow the true quality are informative: better than knowing only the base rates
  assert.ok(e.skill.vsBase.rps > 0.02, `skill ${e.skill.vsBase.rps}`);
  assert.ok(e.metrics.model.x12.rps < e.metrics.base.x12.rps);
  assert.ok(e.fit.kappa.mean > 0.2 && e.fit.kappa.mean < 2, JSON.stringify(e.fit));
  assert.ok(e.fit.origins >= 20 && e.skippedOrigins >= 1);
  assert.deepEqual(e.flags, []);
  assert.ok(!rep.warnings.some((w) => /elo-only/.test(w.code)));
  assert.ok(lines.some((l) => /\[CL Elo-only on domestic matches\] \d+ matches \(PL\) \| RPS [\d.]+ vs base [\d.]+ → skill [+-]?[\d.]+%/.test(l)), lines.filter((l) => /Elo-only/.test(l)).join('\n'));
  // the exit code, the league numbers and tune.json are what they were without this test
  const without = await runTune({ prevDir: branchWithoutCache(), outDir: tmp('eloonly-off'), aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: synth, fetchElo: syntheticElo(synth) });
  assert.deepEqual(without.report.leagues.PL.metrics, rep.leagues.PL.metrics);
  assert.deepEqual(without.tune.leagues.PL, res.tune.leagues.PL);
  state.eloOnlyOut = outDir;
});

test('Elo-only model: a week without ClubElo keeps last week\'s numbers, marked stale; a sample that is too small is only a warning', async () => {
  const prev = tmp('eloonly-prev');
  fs.cpSync(state.eloOnlyOut, prev, { recursive: true });
  fs.rmSync(path.join(prev, 'cache'), { recursive: true, force: true }); // no cached snapshots either
  const lastWeek = readJson(prev, 'report.json');
  const synth = syntheticCsv({ nTeams: 18 });
  const down = await runTune({ prevDir: prev, outDir: tmp('eloonly-down'), aliasesPath: ALIASES, now: new Date(NOW.getTime() + 7 * 86400000), logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: synth, fetchElo: eloDown, eloOnlyMinRows: 100 });
  assert.equal(down.publish, true);
  const e = down.report.eloOnly;
  assert.equal(e.stale, true);
  assert.equal(e.staleSince, lastWeek.generatedAt);
  assert.match(e.staleReason, /ClubElo/);
  assert.deepEqual(e.metrics, lastWeek.eloOnly.metrics, 'the numbers are last week\'s, not invented');
  // a second week in a row keeps the ORIGINAL "stale since"
  const prev2 = tmp('eloonly-prev2');
  fs.cpSync(prev, prev2, { recursive: true });
  fs.writeFileSync(path.join(prev2, 'report.json'), JSON.stringify(down.report));
  fs.writeFileSync(path.join(prev2, 'tune.json'), JSON.stringify(down.tune));
  const down2 = await runTune({ prevDir: prev2, outDir: tmp('eloonly-down2'), aliasesPath: ALIASES, now: new Date(NOW.getTime() + 14 * 86400000), logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: synth, fetchElo: eloDown, eloOnlyMinRows: 100 });
  assert.equal(down2.report.eloOnly.staleSince, lastWeek.generatedAt);

  // ratings exist but the pooled sample is below the production minimum: a Greek warning, nothing carried over from nowhere
  const small = await runTune({ prevDir: branchWithoutCache(), outDir: tmp('eloonly-small'), aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: synth, fetchElo: syntheticElo(synth) });
  assert.equal(small.report.eloOnly, undefined);
  const w = small.report.warnings.find((x) => x.code === 'elo-only-skipped');
  assert.ok(w, JSON.stringify(small.report.warnings.map((x) => x.code)));
  assert.match(w.message, /^Δοκιμή μοντέλου μόνο-Elo \(Champions League\): δεν αξιολογήθηκε - /);
  assert.match(w.message, /aliases\.json/);
  assert.equal(small.exitCode, 0);
});

test('half-time markets (Phase 3): scored against the base rates in the weekly report, null without half-time scores', async () => {
  // data without half-time columns: nothing to report, no warning, nothing breaks
  const plain = await runTune({ prevDir: branchWithoutCache(), outDir: tmp('nohalf'), aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: syntheticCsv(), fetchElo: eloDown });
  assert.equal(plain.report.leagues.PL.htft, null);
  assert.ok(!plain.report.leagues.PL.flags.some((f) => f.code === 'htft-below-base'));
  assert.equal(plain.exitCode, 0);

  // 45 % of every team's goals fall in the first half
  const outDir = tmp('half');
  const lines = [];
  const res = await runTune({ prevDir: branchWithoutCache(), outDir, aliasesPath: ALIASES, now: NOW, logger: { log: (m) => lines.push(String(m)), warn() {}, error() {} }, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: syntheticCsv({ halfShare: 0.45 }), fetchElo: eloDown });
  assert.equal(res.exitCode, 0);
  const r = readJson(outDir, 'report.json').leagues.PL;
  assert.ok(r.htft, 'half-time block present');
  assert.ok(r.htft.n >= MIN_HALF_MATCHES && r.htft.n <= r.matches, `n ${r.htft.n} of ${r.matches}`);
  for (const side of ['model', 'base']) {
    for (const [market, key] of [['ht', 'rps'], ['ht', 'logLoss'], ['htft', 'logLoss'], ['over05', 'logLoss'], ['over15', 'logLoss']]) {
      const v = r.htft[side][market][key];
      assert.ok(Number.isFinite(v) && v > 0, `${side}.${market}.${key} = ${v}`);
    }
  }
  assert.deepEqual(Object.keys(r.htft.skill).sort(), ['htLogLoss', 'htRps', 'htft', 'over05', 'over15']);
  // the model knows the teams and the true first-half share: clearly better than the league base rates
  assert.ok(r.htft.skill.htRps > 0.01, `half-time RPS skill ${r.htft.skill.htRps}`);
  assert.ok(r.htft.skill.htLogLoss > 0 && r.htft.skill.htft > 0, JSON.stringify(r.htft.skill));
  assert.ok(!r.flags.some((f) => f.code === 'htft-below-base'));
  assert.ok(lines.some((l) => /half-time RPS skill [+-]?\d/.test(l)), 'the console summary shows the half-time line');
  // goals markets are unaffected by the half-time columns
  assert.equal(r.matches, plain.report.leagues.PL.matches);
  assert.equal(r.metrics.model.x12.rps, plain.report.leagues.PL.metrics.model.x12.rps);
});

test('half-time warning: a negative half-time skill is a warning only, it never changes the exit code', () => {
  assert.deepEqual(halfFlags(null), []);
  assert.deepEqual(halfFlags({ skill: { htRps: null } }), []);
  assert.deepEqual(halfFlags({ skill: { htRps: 0 } }), []);
  assert.deepEqual(halfFlags({ skill: { htRps: 0.04 } }), []);
  const [f, ...rest] = halfFlags({ skill: { htRps: -0.0312 } });
  assert.equal(rest.length, 0);
  assert.equal(f.code, 'htft-below-base');
  assert.match(f.message, /−?-?3,1%/);
  assert.notEqual(f.code, 'skill-below-8pct', 'only the full-time flag decides the exit code');
});

test('a league below the 8 % RPS limit is flagged loudly: exit 1, but the report is still published', async () => {
  const outDir = tmp('noise');
  const res = await runTune({ prevDir: branchWithoutCache(), outDir, aliasesPath: ALIASES, now: NOW, logger: quiet, only: ['PL'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: syntheticCsv({ attSd: 0, defSd: 0 }), fetchElo: eloDown });
  assert.equal(res.exitCode, 1);
  assert.equal(res.publish, true);
  const r = readJson(outDir, 'report.json');
  assert.ok(r.leagues.PL.skill.vsBase.rps < MIN_SKILL, `skill ${r.leagues.PL.skill.vsBase.rps}`);
  assert.ok(r.leagues.PL.flags.some((f) => f.code === 'skill-below-8pct'));
  assert.match(r.leagues.PL.flags[0].message, /8%/);
  assert.ok(r.pooled.flags.some((f) => f.code === 'skill-below-8pct'));
  // the numbers are still handed over to the daily refresh (they are what the back-test found)
  assert.ok(sanitizeParams(readJson(outDir, 'tune.json').leagues.PL.params));
});

test('downloads fail but the cache is complete: the old CSV copies are used, nothing is lost', async () => {
  const later = new Date(NOW.getTime() + 40 * 86400000); // the cached seasons are now older than 30 days
  const lines = [];
  const logger = { log() {}, error: (m) => lines.push(String(m)), warn() {} };
  const outDir = tmp('oldcache');
  const res = await runTune({
    prevDir: state.out,
    outDir,
    aliasesPath: ALIASES,
    now: later,
    logger,
    only: ['PL'],
    bootstrapK: 4,
    sleepFn: async () => {},
    // 2021/22 and 2022/23 never existed in the mock; everything else is "down"
    fetchCsv: async (_div, code) => {
      if (code === '2122' || code === '2223') return { missing: true, rows: [] };
      throw new Error('football-data.co.uk is down');
    },
    fetchElo: eloDown,
  });
  assert.equal(res.publish, true);
  assert.ok(lines.some((l) => /using the cache from/.test(l)), lines.join('\n'));
  const files = listAll(outDir);
  for (const code of ['2324', '2425', '2526']) assert.ok(files.includes(`cache/csv-E0-${code}.json.gz`), code);
  // the old copies keep their original download time (they are not pretended to be fresh)
  assert.equal(readGz(path.join(outDir, 'cache', 'csv-E0-2526.json.gz')).fetchedAt, readGz(path.join(state.out, 'cache', 'csv-E0-2526.json.gz')).fetchedAt);
  // the monthly Elo snapshots are historical and never expire
  assert.equal(readJson(outDir, 'report.json').elo.failed, 0);
});

test('nothing could be downloaded and nothing is cached: exit 1, nothing published, the previous files stay', async () => {
  const prev = branchWithoutCache();
  const beforeReport = fs.readFileSync(path.join(prev, 'report.json'));
  const beforeTune = fs.readFileSync(path.join(prev, 'tune.json'));
  const outDir = tmp('failout');
  const res = await runTune({
    prevDir: prev,
    outDir,
    aliasesPath: ALIASES,
    now: NOW,
    logger: quiet,
    only: ['PL'],
    sleepFn: async () => {},
    fetchCsv: async () => {
      throw new Error('football-data.co.uk is down');
    },
    fetchElo: eloDown,
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.publish, false);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'report.json')), beforeReport, 'the last good report is kept');
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'tune.json')), beforeTune, 'the last good tune.json is kept');
  assert.ok(res.warnings.some((w) => w.code === 'tune-data-failed'));
  // and the carried-over daily files are still there
  assert.ok(listAll(outDir).includes('PL.json') && listAll(outDir).includes('index.json'));
});

test('one league fails this week: its last numbers stay, marked stale, and the other league is published', async () => {
  const prev = branchWithoutCache();
  const patch = (name, f) => {
    const file = path.join(prev, name);
    const j = readJson(file);
    f(j);
    fs.writeFileSync(file, JSON.stringify(j));
  };
  const lastWeek = { name: 'Bundesliga', matches: 600, params: { xi: 0.0025, sigma: 0.2, om: 0.8, elo: true }, metrics: { model: { n: 600 } }, skill: { vsBase: { rps: 0.12 } }, flags: [] };
  patch('report.json', (j) => {
    j.leagues.BL1 = lastWeek;
  });
  patch('tune.json', (j) => {
    j.leagues.BL1 = { params: lastWeek.params, source: 'tuned', matches: 600 };
  });
  const outDir = tmp('stale');
  const synth = syntheticCsv();
  const res = await runTune({
    prevDir: prev,
    outDir,
    aliasesPath: ALIASES,
    now: NOW,
    logger: quiet,
    only: ['PL', 'BL1'],
    bootstrapK: 4,
    sleepFn: async () => {},
    fetchCsv: async (div, code) => {
      if (div === 'D1') throw new Error('timeout');
      return synth(div, code);
    },
    fetchElo: eloDown,
  });
  assert.equal(res.publish, true);
  assert.equal(res.exitCode, 0, 'a stale league is not a model bug');
  const r = readJson(outDir, 'report.json');
  assert.ok(r.leagues.PL.metrics && !r.leagues.PL.stale);
  assert.equal(r.leagues.BL1.stale, true);
  assert.equal(r.leagues.BL1.staleSince, r.generatedAt === NOW.toISOString() ? readJson(prev, 'report.json').generatedAt : null);
  assert.ok(r.leagues.BL1.staleReason);
  assert.deepEqual(r.leagues.BL1.params, lastWeek.params);
  assert.ok(r.warnings.some((w) => w.code === 'tune-data-failed' && w.league === 'BL1'));
  const t = readJson(outDir, 'tune.json');
  assert.deepEqual(t.leagues.BL1.params, lastWeek.params, 'the daily refresh keeps using the last tuned parameters');
  // a second consecutive failure keeps the ORIGINAL "stale since"
  const out2 = tmp('stale2');
  await runTune({ prevDir: outDir, outDir: out2, aliasesPath: ALIASES, now: new Date(NOW.getTime() + 7 * 86400000), logger: quiet, only: ['PL', 'BL1'], bootstrapK: 4, sleepFn: async () => {}, fetchCsv: async (div, code) => (div === 'D1' ? Promise.reject(new Error('timeout')) : synth(div, code)), fetchElo: eloDown });
  assert.equal(readJson(out2, 'report.json').leagues.BL1.staleSince, r.leagues.BL1.staleSince);
});

test('an unsafe tune.json can never reach the published files (data-branch check)', async () => {
  const { checkOutput } = await import('../scripts/data-branch.mjs');
  const dir = tmp('check');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 1, leagues: [{ code: 'PL', file: 'PL.json' }] }));
  fs.writeFileSync(path.join(dir, 'PL.json'), '{}');
  assert.doesNotThrow(() => checkOutput({ outDir: dir, partialRun: false }));
  for (const name of ['tune.json', 'report.json', 'ai-cache.json']) {
    fs.writeFileSync(path.join(dir, name), '{"ok":true}');
    assert.doesNotThrow(() => checkOutput({ outDir: dir, partialRun: false }), name);
    fs.writeFileSync(path.join(dir, name), '{broken');
    assert.throws(() => checkOutput({ outDir: dir, partialRun: false }), new RegExp(`${name} is not valid JSON`));
    fs.rmSync(path.join(dir, name));
  }
});

test('job summary of the weekly run: a readable table, stale and failed leagues included, never a crash', async () => {
  const { renderTuneSummary } = await import('../scripts/job-summary.mjs');
  const report = readJson(state.out, 'report.json');
  report.leagues.XX = { name: 'Broken | League', error: 'δεν κατέβηκαν τα δεδομένα' };
  report.leagues.YY = { ...report.leagues.PL, name: 'Old', stale: true, staleReason: 'timeout' };
  const text = renderTuneSummary(report);
  assert.match(text, /Premier League \(PL\)/);
  assert.match(text, /Broken \\\| League/, 'a pipe inside a name must not break the table');
  assert.match(text, /παλιά αποτελέσματα/);
  assert.match(text, /Βαθμονόμηση πιθανοτήτων/);
  assert.match(text, /Συνολικά/);
  // half-time markets (Phase 3): one line with the improvement of every league that has them
  assert.ok(report.leagues.PL.htft, 'fixture: the mock league has half-time scores');
  assert.match(text, new RegExp(`\\*\\*Ημίχρονο \\(βελτίωση RPS ημιχρόνου έναντι βασικών συχνοτήτων\\):\\*\\* PL [+-]?\\d+,\\d% \\(${report.leagues.PL.htft.n} αγώνες\\)`));
  assert.doesNotThrow(() => renderTuneSummary({}));
  assert.doesNotThrow(() => renderTuneSummary(null));
  assert.doesNotThrow(() => renderTuneSummary({ leagues: { PL: null, BL1: { metrics: {} } } }));
});

test('the data branch is rebuilt from the previous content: copyTree skips what is rewritten, carryOver keeps what other jobs created', async () => {
  const { copyTree, createCache } = await import('../src/pipeline/cache.js');
  const prev = tmp('ct-prev');
  const write = (dir, rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  for (const rel of ['index.json', 'PL.json', 'tune.json', 'report.json', 'cache/a.json.gz', 'cache/b.json.gz', 'sub/dir/deep.txt']) write(prev, rel, rel);
  const out = tmp('ct-out');
  copyTree(prev, out, (rel) => rel === 'tune.json' || rel === 'cache/b.json.gz');
  assert.deepEqual(listAll(out), ['PL.json', 'cache/a.json.gz', 'index.json', 'report.json', 'sub/dir/deep.txt']);
  assert.equal(fs.readFileSync(path.join(out, 'sub/dir/deep.txt'), 'utf8'), 'sub/dir/deep.txt');

  // carryOver: copies only wanted entries that this run did not write itself
  const out2 = tmp('ct-out2');
  const cache = createCache(prev, out2);
  cache.put('c', { fresh: true });
  fs.mkdirSync(path.dirname(cache.outPath('a')), { recursive: true });
  fs.writeFileSync(cache.outPath('b'), 'rewritten-by-this-run');
  assert.equal(cache.carryOver((name) => name === 'a' || name === 'b'), 1, 'only a is copied: b already exists in the output');
  assert.equal(fs.readFileSync(cache.outPath('b'), 'utf8'), 'rewritten-by-this-run');
  assert.equal(fs.readFileSync(cache.outPath('a'), 'utf8'), 'cache/a.json.gz');
  assert.equal(createCache(tmp('none'), out2).carryOver(() => true), 0, 'no previous cache folder is fine');
});

test('workflows: both jobs share the data-branch lock, schedule off the hour, and keep secrets out of the weekly job', () => {
  const read = (n) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', n), 'utf8');
  const tune = read('tune.yml');
  const refresh = read('refresh.yml');
  for (const wf of [tune, refresh]) {
    assert.match(wf, /concurrency:\s*\n\s+group: data-branch\s*\n\s+cancel-in-progress: false/);
    assert.match(wf, /workflow_dispatch:/);
    assert.doesNotMatch(wf, /push:\s*\n\s+branches/, 'a workflow that rewrites the data branch must not run on pushes');
    assert.doesNotMatch(wf, /echo\s+.*\$\{\{\s*secrets\./, 'secrets are never echoed');
  }
  assert.match(tune, /cron: '37 3 \* \* 1'/);
  assert.doesNotMatch(tune, /secrets\./, 'the weekly job downloads public files only');
  assert.match(refresh, /GROQ_API_KEY: \$\{\{ secrets\.GROQ_API_KEY \}\}/);
  assert.match(refresh, /GROQ_MODEL: \$\{\{ vars\.GROQ_MODEL \}\}/);
  assert.match(tune, /steps\.tune\.outputs\.publish == 'true'/);
});

test('timing sanity: the whole weekly run of one mock league takes seconds, not minutes', () => {
  assert.ok(state.seconds < 90, `took ${state.seconds}s`);
  assert.match(state.lines, /TUNING SUMMARY/);
  assert.ok(!state.lines.includes('test-token'));
});
