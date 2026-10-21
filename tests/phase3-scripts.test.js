// Phase 3 helper scripts against the Phase 3 mock servers: check-sources (Champions League, half-time
// columns, API-Football referee / injuries probe) and build-aliases (Champions League club names).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld3, startMockServer3 } from './mock-world3.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startMockServer3(buildWorld3());
after(() => server.close());

const SECRETS = ['test-token', 'apif-test'];
const baseEnv = {
  ...process.env,
  FD_ORG_BASE: `${server.url}/v4`,
  FD_CSV_BASE: `${server.url}/mmz4281`,
  ELO_BASE: server.url,
  API_FOOTBALL_BASE: `${server.url}/apif`,
  FD_ORG_MIN_INTERVAL_MS: '0',
  CSV_PAUSE_MS: '0',
  HTTP_BACKOFF_MS: '0',
  API_FOOTBALL_MIN_INTERVAL_MS: '0',
  FP_NOW: '2026-10-18T10:00:00Z',
};
for (const k of ['FOOTBALL_DATA_TOKEN', 'GROQ_API_KEY', 'API_FOOTBALL_KEY', 'GROQ_MODEL', 'ALIASES_PATH', 'ALIASES_BUILTIN', 'FP_ONLY']) delete baseEnv[k];

function run(script, extra = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', script)],
      { env: { ...baseEnv, ...extra }, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, out: `${stdout}\n${stderr}` }),
    );
  });
}
const noSecrets = (out) => SECRETS.forEach((s) => assert.ok(!out.includes(s), `secret "${s}" leaked into the output`));
const KEYS = { FOOTBALL_DATA_TOKEN: 'test-token', API_FOOTBALL_KEY: 'apif-test' };

test('check-sources (Champions League): fixtures, two seasons of results with extra time, clubs, half-time and referee columns', async () => {
  const r = await run('check-sources.mjs', { ...KEYS, FP_ONLY: 'PL,CL' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ fixtures CL \(next 7 days\): 9 fixtures, stages: LEAGUE_STAGE, FINAL/);
  assert.match(r.out, /sample: \{"id":770000,"kickoff":"2026-10-20T19:00:00\.000Z","status":"TIMED","matchday":3,"stage":"LEAGUE_STAGE"/);
  assert.match(r.out, /✅ results CL 2026 \(current\): 24 finished matches \| 90-minute score on 24 .* half-time score on 24/);
  // the previous season has extra time and a penalty shoot-out without a 90-minute score: said openly
  assert.match(r.out, /✅ results CL 2025 \(previous\): 60 finished matches \| 90-minute score on 59 \| extra time \/ penalties 3 \(1 without a 90-minute score are not used\)/);
  assert.match(r.out, /sample \(extra time \/ penalties\): \{"id":\d+,.*"duration":"EXTRA_TIME"/);
  assert.match(r.out, /✅ teams CL: 16 clubs/);
  assert.match(r.out, /✅ E0 2526: 380 matches \| corners 100% \| yellows 100% \| shots 100% \| half-time 100% \| referee 100%/);
  // one club of the draw is unknown to ClubElo: a warning with the way out, not a failure
  assert.match(r.out, /⚠️ +Champions League clubs vs ClubElo: 1 of 16 not matched \("Zzyzx FC"\)/);
  assert.match(r.out, /Ονόματα ομάδων/);
  assert.match(r.out, /All required checks passed/);
  noSecrets(r.out);
});

test('check-sources (API-Football): parses fixtures and injuries with the same code as the pipeline and counts its requests', async () => {
  const before = server.state.apifCalls;
  const r = await run('check-sources.mjs', { ...KEYS, FP_ONLY: 'PL,CL' });
  assert.equal(r.code, 0, r.out);
  assert.equal(server.state.apifCalls - before, 3, 'access test + Champions League fixtures + one injuries call');
  assert.match(r.out, /✅ API-Football current season: season accessible; requests left today: \d+/);
  assert.match(r.out, /✅ API-Football fixtures PL: 8 fixtures in the next 7 days, referee named on 1/);
  assert.match(r.out, /✅ API-Football fixtures CL: 8 fixtures in the next 7 days, referee named on 0/);
  assert.match(r.out, /sample: \{"id":9000,"kickoff":"2026-10-18T14:00:00\.000Z","status":"NS","home":\{"id":1,"name":"Arsenal"\}/);
  assert.match(r.out, /✅ API-Football injuries: 5 records for 6 fixtures \(4 will miss the match, 1 doubtful; reasons: injury, suspension; 1 ignored\)/);
  assert.match(r.out, /"playerName":"A\. Striker","state":"out","reason":"Thigh Injury","kind":"injury"/);
  assert.match(r.out, /requests used by this check: 3/);
  // the key travels in a header only
  assert.ok(server.state.apifKeys.slice(-3).every((k) => k === 'apif-test'));
  assert.ok(server.state.apifLog.slice(-3).every((u) => !u.includes('apif-test')));
  noSecrets(r.out);
});

test('check-sources (API-Football): plan refusal (HTTP 200 + errors) stops after one request and says why; no key = skipped', async () => {
  server.set({ apif: 'plan' });
  try {
    const before = server.state.apifCalls;
    const r = await run('check-sources.mjs', { ...KEYS, FP_ONLY: 'PL,CL' });
    assert.equal(r.code, 0, r.out);
    assert.equal(server.state.apifCalls - before, 1);
    assert.match(r.out, /extras DISABLED: plan: Free plans do not have access to this season/);
    assert.doesNotMatch(r.out, /API-Football fixtures CL/);
    noSecrets(r.out);
  } finally {
    server.set({ apif: 'ok' });
  }
  const none = await run('check-sources.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', FP_ONLY: 'CL' });
  assert.match(none.out, /⏭️ +API-Football: API_FOOTBALL_KEY is not set \(optional\)/);
});

test('check-sources (Champions League): a restricted previous season is a warning that explains the consequence; a dead endpoint never fails the run', async () => {
  server.set({ clPrevious: 403, clFixtures: 500, clResults: 'ok' });
  try {
    const r = await run('check-sources.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', FP_ONLY: 'CL' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /⚠️ +results CL 2025 \(previous\): HTTP 403: last season's matches are not available on the free plan, so they are ignored/);
    assert.match(r.out, /⚠️ +fixtures CL \(next 7 days\): .*500.*\(the Champions League tab will be empty\)/);
    assert.match(r.out, /✅ results CL 2026 \(current\)/);
  } finally {
    server.set({ clPrevious: 'ok', clFixtures: 'ok' });
  }
});

test('build-aliases (Champions League): clubs of every country are compared with ClubElo, the unknown one is listed, exit 1', async () => {
  const r = await run('build-aliases.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', FP_ONLY: 'CL' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[CL\] Champions League/);
  assert.match(r.out, /❌ football-data\.org vs ClubElo \(decides if matches are used\): 1 of 16 NOT matched/);
  assert.match(r.out, /- "Zzyzx FC" \(short: "Zzyzx"\) \[none\]/);
  assert.match(r.out, /1 football-data\.org name\(s\) cannot be matched: their fixtures are SKIPPED/);
  noSecrets(r.out);
});

test('build-aliases (Champions League): a similar-looking spelling is accepted but listed for a human check; without a token nothing is compared', async () => {
  // no built-in list, no own list: "Olympiacos FC" is only matched by similarity to "Olympiakos"
  const r = await run('build-aliases.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', FP_ONLY: 'CL', ALIASES_BUILTIN: 'off', ALIASES_PATH: path.join(os.tmpdir(), 'fp-no-such-aliases.json') });
  assert.match(r.out, /~ "Olympiacos FC" was matched by similarity \(0\.9\d\) to "Olympiakos": check that this is the same club/);
  const noToken = await run('build-aliases.mjs', { FP_ONLY: 'CL' });
  assert.equal(noToken.code, 0, noToken.out);
  assert.match(noToken.out, /FOOTBALL_DATA_TOKEN is not set: football-data\.org names are not checked/);
});

test('a broken aliases.json is reported by the scripts and never stops them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-alias-broken-'));
  const broken = path.join(dir, 'aliases.json');
  fs.writeFileSync(broken, '{ "Man City": ["Manchester City"] "Wolves": ["Wolverhampton"] }'); // a comma is missing
  const r = await run('build-aliases.mjs', { FOOTBALL_DATA_TOKEN: 'test-token', FP_ONLY: 'CL', ALIASES_PATH: broken });
  assert.match(r.out, /⚠️ +Το aliases\.json δεν είναι έγκυρο JSON .* και αγνοήθηκε/);
  assert.match(r.out, /\[CL\] Champions League/, 'the script went on with the built-in list');
});
