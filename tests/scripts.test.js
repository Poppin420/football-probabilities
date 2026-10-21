// The helper scripts (check-sources, build-aliases, tune) run as real child
// processes against the local mock servers. The live providers cannot be
// reached from the test environment, so this proves the scripts execute,
// read the response shapes correctly, report problems and never print secrets.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld, startMockServer } from './mock-world.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const world = buildWorld();
const server = await startMockServer(world);
after(() => server.close());

const SECRETS = ['test-token', 'groq-test', 'apif-test'];
const baseEnv = {
  ...process.env,
  FD_ORG_BASE: `${server.url}/v4`,
  FD_CSV_BASE: `${server.url}/mmz4281`,
  ELO_BASE: server.url,
  GROQ_BASE: `${server.url}/groq`,
  API_FOOTBALL_BASE: `${server.url}/apif`,
  FD_ORG_MIN_INTERVAL_MS: '0',
  CSV_PAUSE_MS: '0',
  HTTP_BACKOFF_MS: '0',
  FP_NOW: '2026-10-18T10:00:00Z',
  FP_ONLY: 'PL',
};
for (const k of ['FOOTBALL_DATA_TOKEN', 'GROQ_API_KEY', 'API_FOOTBALL_KEY', 'GROQ_MODEL', 'ALIASES_PATH', 'ALIASES_BUILTIN']) delete baseEnv[k];

function run(script, extra = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', script)],
      { env: { ...baseEnv, ...extra }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, out: `${stdout}\n${stderr}` }),
    );
  });
}

function assertNoSecrets(out) {
  for (const s of SECRETS) assert.ok(!out.includes(s), `secret "${s}" leaked into the output`);
}

test('check-sources: every source passes against the mock servers, one sample each', async () => {
  const r = await run('check-sources.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', GROQ_API_KEY: 'groq-test', API_FOOTBALL_KEY: 'apif-test' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ fixtures PL \(next 7 days\): 10 fixtures/);
  assert.match(r.out, /sample: \{"id":540000/); // one fd.org fixture sample
  assert.match(r.out, /✅ date range 8 days/);
  assert.match(r.out, /✅ date range 11 days/);
  assert.match(r.out, /longest accepted range: 11 days/);
  assert.match(r.out, /✅ teams PL: 20 teams/);
  assert.match(r.out, /✅ scorers PL 2026 \(current\): 40 players/);
  assert.match(r.out, /⚠️ +scorers PL 2025 \(previous\): HTTP 403/); // restricted, reported not thrown
  assert.match(r.out, /✅ E0 2526: \d+ matches \| corners 100% \| yellows 100%/);
  assert.match(r.out, /columns found: date,time,home,away,fthg/);
  assert.match(r.out, /✅ ClubElo snapshot: 23 clubs on 2026-10-18/);
  assert.match(r.out, /✅ Groq key: key accepted; 2 models active; first choice "openai\/gpt-oss-120b" is available; fallback "openai\/gpt-oss-20b" is available/);
  assert.match(r.out, /✅ API-Football current season: season accessible; requests left today: 93/);
  assert.match(r.out, /All required checks passed/);
  assertNoSecrets(r.out);
});

test('check-sources: API-Football refusing with HTTP 200 + errors disables the extras and says why', async () => {
  server.set({ apiFootball: 'plan' });
  try {
    const r = await run('check-sources.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', API_FOOTBALL_KEY: 'apif-test' });
    assert.equal(r.code, 0, r.out); // optional source: the run itself is not a failure
    assert.match(r.out, /extras DISABLED: plan: Free plans do not have access to this season/);
    assertNoSecrets(r.out);
  } finally {
    server.set({ apiFootball: 'ok' });
  }
});

test('check-sources: a missing token or a dead fixtures endpoint is a required failure (exit 1)', async () => {
  const noToken = await run('check-sources.mjs');
  assert.equal(noToken.code, 1);
  assert.match(noToken.out, /FOOTBALL_DATA_TOKEN is not set/);
  assert.match(noToken.out, /⏭️ +Groq key: GROQ_API_KEY is not set/);

  server.set({ fixturesStatus: 500 });
  try {
    const r = await run('check-sources.mjs', { FOOTBALL_DATA_TOKEN: 'test-token' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /❌ fixtures PL \(next 7 days\)/);
    assert.match(r.out, /1 REQUIRED check\(s\) failed/);
    assertNoSecrets(r.out);
  } finally {
    server.set({ fixturesStatus: 200 });
  }
});

test('build-aliases: with the real aliases.json every football-data.org name matches; old clubs missing in Elo are listed', async () => {
  const r = await run('build-aliases.mjs', { FOOTBALL_DATA_TOKEN: 'test-token' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ football-data\.org vs CSV \+ ClubElo \(decides if fixtures are used\): all 20 names matched/);
  assert.match(r.out, /❌ CSV teams vs ClubElo/);
  assert.match(r.out, /"Burnley" \[none\]/); // not in the mock Elo list
  assert.match(r.out, /only the Elo number depends on it|missing in ClubElo/);
  assertNoSecrets(r.out);
});

test('build-aliases: without any aliases an unmatched fixture name is reported (exit 1) and a paste-ready line is suggested', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-alias-'));
  const empty = path.join(dir, 'aliases.json');
  fs.writeFileSync(empty, '{}');
  const r = await run('build-aliases.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', ALIASES_PATH: empty, ALIASES_BUILTIN: 'off' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT matched/);
  assert.match(r.out, /"Wolverhampton Wanderers FC"/);
  assert.match(r.out, /fixtures are SKIPPED until an alias is added/);
  // The right clubs are suggested ...
  assert.ok(r.out.includes(`  "Wolves": ["Wolverhampton Wanderers FC"],`), `suggested line missing:\n${r.out}`);
  assert.ok(r.out.includes(`  "Forest": ["Nott'm Forest"],`), `suggested line missing:\n${r.out}`);
  // ... and never a club that is already matched by another name (Burnley is not Bournemouth).
  assert.ok(!r.out.includes('"Bournemouth": ["Burnley"]'), r.out);
  assert.ok(!r.out.includes('"Leicester": ["Leeds"]'), r.out);
  assertNoSecrets(r.out);
});

test('build-aliases: without a token it still compares CSV and ClubElo and says what it skipped', async () => {
  const r = await run('build-aliases.mjs');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FOOTBALL_DATA_TOKEN is not set: football-data\.org names are not checked/);
  assert.match(r.out, /CSV teams vs ClubElo/);
});

test('tune.mjs: nothing to tune without data; with data it writes report.json + tune.json and tells the workflow what to publish', async () => {
  const tmp = (l) => fs.mkdtempSync(path.join(os.tmpdir(), `fp-script-${l}-`));
  const outputFile = (dir) => path.join(dir, 'github-output.txt');

  // 1) a brand-new repository: no branch "data" yet
  const empty = tmp('empty');
  const out0 = tmp('out0');
  const r0 = await run('tune.mjs', { PREV_DIR: empty, OUT_DIR: out0, GITHUB_OUTPUT: outputFile(out0) });
  assert.equal(r0.code, 0, r0.out);
  assert.match(r0.out, /Δεν υπάρχουν δεδομένα στο branch "data"/);
  assert.equal(fs.readFileSync(outputFile(out0), 'utf8').trim(), 'publish=false');

  // 2) after a daily refresh
  const branch = tmp('branch');
  const r1 = await run('refresh.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', PREV_DIR: empty, OUT_DIR: branch });
  assert.equal(r1.code, 0, r1.out);
  const out = tmp('out');
  const r2 = await run('tune.mjs', { PREV_DIR: branch, OUT_DIR: out, GITHUB_OUTPUT: outputFile(out), FP_BOOTSTRAP_K: '8' });
  assertNoSecrets(r2.out);
  assert.match(r2.out, /TUNING SUMMARY/);
  assert.equal(fs.readFileSync(outputFile(out), 'utf8').trim(), 'publish=true');
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.window.bootstrapK, 8, 'the debug hook is recorded in the report');
  assert.ok(fs.existsSync(path.join(out, 'tune.json')) && fs.existsSync(path.join(out, 'PL.json')) && fs.existsSync(path.join(out, 'index.json')));
  // exit code 1 exactly when a league (or the pool) is below the 8 % RPS limit
  const flagged = Object.values(report.leagues).some((l) => l.flags?.some((f) => f.code === 'skill-below-8pct')) || report.pooled.flags.length > 0;
  assert.equal(r2.code, flagged ? 1 : 0, r2.out);
  if (flagged) assert.match(r2.out, /BELOW THE 8% RPS LIMIT/);
});
