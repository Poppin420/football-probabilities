// The "data" branch helpers (scripts/data-branch.mjs) run against a real local
// git repository that plays the part of GitHub. Actions itself cannot run in the
// test environment, but everything git does in the workflow is exercised here:
// first run without a data branch, publish as ONE orphan commit, replace, refuse
// incomplete output, fail loudly when the remote cannot be reached, and never
// leak the token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authEnv, settingsFromEnv } from '../scripts/data-branch.mjs';
import { renderSummary } from '../scripts/job-summary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'data-branch.mjs');
const SUMMARY_SCRIPT = path.join(ROOT, 'scripts', 'job-summary.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-databranch-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let counter = 0;
/** A normal repository with a "main" branch that holds the (pretend) site sources. */
function newRemote() {
  const dir = path.join(tmpRoot, `remote-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>site</p>');
  git(dir, 'add', '.');
  git(dir, ...GIT_ID, 'commit', '--quiet', '-m', 'site');
  return { dir, url: pathToFileURL(dir).href };
}

function newWorkspace() {
  const dir = path.join(tmpRoot, `work-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeOutput(outDir, { league = 'PL', extra = {} } = {}) {
  fs.mkdirSync(path.join(outDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(outDir, `${league}.json`), JSON.stringify({ schema: 1, league: { code: league }, matches: [] }));
  fs.writeFileSync(path.join(outDir, 'cache', 'elo.json.gz'), Buffer.from([0x1f, 0x8b, 8, 0]));
  fs.writeFileSync(
    path.join(outDir, 'index.json'),
    JSON.stringify({ schema: 1, generatedAt: '2026-10-18T05:07:00.000Z', leagues: [{ code: league, name: league, file: `${league}.json`, status: 'ok' }], warnings: [], sources: {}, ...extra }),
  );
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['GITHUB_TOKEN', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_RUN_ID', 'GITHUB_STEP_SUMMARY', 'FP_ONLY', 'DATA_BRANCH', 'GIT_CONFIG_COUNT']) delete env[k];
  return env;
}

function runScript(script, args, { env = {}, cwd, dropProxy = false } = {}) {
  const full = { ...cleanEnv(), GIT_RETRY_DELAY_MS: '0', ...env };
  if (dropProxy) for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete full[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd, env: full, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}\n${stderr}` });
    });
  });
}

const dataBranch = (remote, ...args) => runScript(SCRIPT, args, { env: { DATA_REMOTE: remote.url }, cwd: remote.work });

test('fetch on a repository without a data branch is a normal first run: empty data-prev, exit 0', async () => {
  const remote = newRemote();
  const work = newWorkspace();
  const r = await runScript(SCRIPT, ['fetch'], { env: { DATA_REMOTE: remote.url }, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No "data" branch yet \(first run\)/);
  assert.deepEqual(fs.readdirSync(path.join(work, 'data-prev')), []);
});

test('publish creates ONE root commit on "data" with the files; main is untouched', async () => {
  const remote = newRemote();
  const work = newWorkspace();
  const mainBefore = git(remote.dir, 'rev-parse', 'main');
  writeOutput(path.join(work, 'data-out'));
  const r = await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url }, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Published \d+ files \(\d+ KB\) to branch "data" as one commit/);

  assert.equal(git(remote.dir, 'rev-parse', 'main'), mainBefore, 'main must not change');
  assert.equal(git(remote.dir, 'rev-list', '--count', 'data'), '1');
  assert.doesNotMatch(git(remote.dir, 'cat-file', 'commit', 'data'), /^parent /m, 'must be a root commit');
  assert.match(git(remote.dir, 'log', '-1', '--format=%an <%ae>|%s', 'data'), /^github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>\|Data 2026-10-18T05:07:00\.000Z$/);
  const files = git(remote.dir, 'ls-tree', '-r', '--name-only', 'data').split('\n').sort();
  assert.deepEqual(files, ['PL.json', 'README.md', 'cache/elo.json.gz', 'index.json', 'netlify.toml']);
  assert.match(git(remote.dir, 'show', 'data:netlify.toml'), /ignore = "exit 0"/);
  assert.equal(git(remote.dir, 'show', 'main:index.html'), '<p>site</p>');
});

test('a second publish replaces the branch: still one commit, old files gone, never any history', async () => {
  const remote = newRemote();
  const work = newWorkspace();
  writeOutput(path.join(work, 'data-out'), { league: 'PL' });
  assert.equal((await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url }, cwd: work })).code, 0);
  const first = git(remote.dir, 'rev-parse', 'data');

  fs.rmSync(path.join(work, 'data-out'), { recursive: true, force: true });
  writeOutput(path.join(work, 'data-out'), { league: 'SA' });
  const r = await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url }, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.notEqual(git(remote.dir, 'rev-parse', 'data'), first);
  assert.equal(git(remote.dir, 'rev-list', '--count', 'data'), '1');
  const files = git(remote.dir, 'ls-tree', '-r', '--name-only', 'data').split('\n');
  assert.ok(files.includes('SA.json') && !files.includes('PL.json'), files.join(','));
});

test('fetch after publish restores the files (without .git), so the next run can use them as its cache', async () => {
  const remote = newRemote();
  const publisher = newWorkspace();
  writeOutput(path.join(publisher, 'data-out'));
  assert.equal((await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url }, cwd: publisher })).code, 0);

  const next = newWorkspace();
  const r = await runScript(SCRIPT, ['fetch'], { env: { DATA_REMOTE: remote.url }, cwd: next });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Restored \d+ files from branch "data"/);
  const prev = path.join(next, 'data-prev');
  assert.ok(fs.existsSync(path.join(prev, 'index.json')) && fs.existsSync(path.join(prev, 'cache', 'elo.json.gz')));
  assert.ok(!fs.existsSync(path.join(prev, '.git')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(prev, 'PL.json'), 'utf8')).league.code, 'PL');
});

test('publish refuses incomplete or partial output and leaves the remote exactly as it was', async () => {
  const remote = newRemote();
  const good = newWorkspace();
  writeOutput(path.join(good, 'data-out'));
  assert.equal((await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url }, cwd: good })).code, 0);
  const before = git(remote.dir, 'rev-parse', 'data');

  const attempt = async (label, prepare, env = {}, expected) => {
    const work = newWorkspace();
    const out = path.join(work, 'data-out');
    writeOutput(out);
    prepare(out);
    const r = await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url, ...env }, cwd: work });
    assert.notEqual(r.code, 0, `${label}: should have been refused\n${r.out}`);
    if (expected) assert.match(r.out, expected, label);
    assert.equal(git(remote.dir, 'rev-parse', 'data'), before, `${label}: remote must be untouched`);
  };

  await attempt('no index.json', (out) => fs.rmSync(path.join(out, 'index.json')), {}, /index\.json is missing/);
  await attempt('broken index.json', (out) => fs.writeFileSync(path.join(out, 'index.json'), '{"schema":'), {}, /not valid JSON/);
  await attempt('wrong schema', (out) => fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ schema: 2, leagues: [{ code: 'PL', file: 'PL.json' }] })), {}, /unexpected shape/);
  await attempt('no leagues', (out) => fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ schema: 1, leagues: [] })), {}, /unexpected shape/);
  await attempt('league file missing', (out) => fs.rmSync(path.join(out, 'PL.json')), {}, /PL\.json is listed in index\.json but is missing/);
  await attempt('league file damaged', (out) => fs.writeFileSync(path.join(out, 'PL.json'), '{"matches":['), {}, /PL\.json is listed/);
  await attempt('unsafe file name', (out) => fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ schema: 1, leagues: [{ code: 'X', file: '../x.json' }] })), {}, /unsafe file name/);
  await attempt('partial debugging run (FP_ONLY)', () => {}, { FP_ONLY: 'PL' }, /FP_ONLY is set/);
});

test('the data branch can never be a source branch', async () => {
  const remote = newRemote();
  const work = newWorkspace();
  writeOutput(path.join(work, 'data-out'));
  const mainBefore = git(remote.dir, 'rev-parse', 'main');
  for (const branch of ['main', 'master', 'HEAD', 'bad name', '../x']) {
    const r = await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url, DATA_BRANCH: branch }, cwd: work });
    assert.notEqual(r.code, 0, branch);
    assert.match(r.out, /Refusing to use/, branch);
  }
  const current = await runScript(SCRIPT, ['publish'], { env: { DATA_REMOTE: remote.url, GITHUB_REF_NAME: 'data' }, cwd: work });
  assert.notEqual(current.code, 0); // the branch the workflow itself runs on is refused as well
  assert.equal(git(remote.dir, 'rev-parse', 'main'), mainBefore);
  assert.throws(() => git(remote.dir, 'rev-parse', '--verify', 'data'), 'nothing was pushed');
});

test('fetch from an unreachable repository FAILS (it must not look like a first run) and retries first', async () => {
  const work = newWorkspace();
  const r = await runScript(SCRIPT, ['fetch'], { env: { DATA_REMOTE: pathToFileURL(path.join(tmpRoot, 'does-not-exist')).href }, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /attempt 1 of 3 failed/);
  assert.match(r.out, /attempt 2 of 3 failed/);
  assert.match(r.out, /ERROR: git ls-remote failed/);
  assert.ok(!fs.existsSync(path.join(work, 'data-prev', 'index.json')));
});

test('GitHub token: sent only as an HTTP header, never printed, not even in error messages', async () => {
  const token = 'ghs_TestTokenValue1234567890';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const work = newWorkspace();
  writeOutput(path.join(work, 'data-out'));
  // Nothing listens on port 1, so every network call fails quickly.
  const common = { env: { DATA_REMOTE: 'https://127.0.0.1:1/owner/repo.git', GITHUB_TOKEN: token, GITHUB_ACTIONS: 'true' }, cwd: work, dropProxy: true };
  const fetched = await runScript(SCRIPT, ['fetch'], common);
  const published = await runScript(SCRIPT, ['publish'], common);
  for (const r of [fetched, published]) {
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes(token), 'the token leaked into the output');
    assert.match(r.out, new RegExp(`::add-mask::${basic.replace(/[+/=]/g, '\\$&')}`)); // the encoded form is registered for masking
    assert.match(r.out, /::error::git (ls-remote|push) failed/);
  }
  const noCredentialsStored = fs.existsSync(path.join(work, 'data-out', '.git', 'config')) ? fs.readFileSync(path.join(work, 'data-out', '.git', 'config'), 'utf8') : '';
  assert.ok(!noCredentialsStored.includes(token) && !noCredentialsStored.includes(basic), 'credentials must not be written to .git/config');
});

test('authEnv: header for https remotes only; settingsFromEnv derives the repository URL in Actions', () => {
  const env = authEnv('https://github.com/me/repo.git', 'tok');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  assert.deepEqual(authEnv('file:///tmp/x', 'tok'), {});
  assert.deepEqual(authEnv('https://github.com/me/repo.git', ''), {});

  const s = settingsFromEnv({ GITHUB_REPOSITORY: 'me/repo', GITHUB_RUN_ID: '42', GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't' });
  assert.equal(s.remote, 'https://github.com/me/repo.git');
  assert.equal(s.branch, 'data');
  assert.equal(s.runUrl, 'https://github.com/me/repo/actions/runs/42');
  assert.throws(() => settingsFromEnv({}), /DATA_REMOTE/);
});

// ----------------------------------------------------------------------------
// Job summary (the table at the bottom of the Actions run page)

const sampleIndex = {
  schema: 1,
  generatedAt: '2026-10-18T05:07:00.000Z',
  leagues: [
    { code: 'PL', name: 'Premier League', status: 'ok', fixtures: 10, matches: 9 },
    { code: 'SA', name: 'Serie A', status: 'stale', fixtures: 8, matches: 8, staleReason: 'HTTP 500 | server\nerror with `ticks`' },
    { code: 'PD', name: 'La Liga', status: 'error', fixtures: 0, matches: 0, staleReason: 'no data', file: null },
  ],
  warnings: [{ code: 'x', message: 'Unmatched <b>team</b> | "Zzyzx"' }],
  sources: { footballDataOrg: { status: 'ok', detail: '24 calls' }, clubElo: { status: 'error', detail: 'timeout' } },
};

test('job summary: one table row per league, special characters cannot break the table', () => {
  const md = renderSummary(sampleIndex);
  assert.match(md, /^## Αποτέλεσμα ανανέωσης δεδομένων/);
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Πρωτάθλημα'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    // 4 cells = 5 unescaped pipes
    assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 5, row);
  }
  assert.match(rows[0], /Premier League \(PL\) \| ✅ ΟΚ \| 9 από 10 \|/);
  assert.match(rows[1], /⚠️ παλιά δεδομένα/);
  assert.match(rows[2], /❌ σφάλμα \| – \|/);
  assert.match(md, /\*\*Πηγές:\*\* footballDataOrg ✅ ΟΚ \(24 calls\) · clubElo ❌ σφάλμα \(timeout\)/);
  assert.match(md, /### Ειδοποιήσεις \(1\)/);
  assert.ok(!md.includes('<b>'), 'HTML must be escaped');
  assert.doesNotThrow(() => renderSummary({}));
  assert.doesNotThrow(() => renderSummary(null));
});

test('job summary (Phase 3): the Elo-only cup is marked, a switched-off source is shown as such, the table keeps its 4 cells', () => {
  const index = {
    ...sampleIndex,
    leagues: [
      { code: 'PL', name: 'Premier League', status: 'ok', fixtures: 10, matches: 9 },
      { code: 'CL', name: 'Champions League', status: 'ok', fixtures: 9, matches: 8, eloOnly: true },
      { code: 'XX', name: 'Broken Cup', status: 'error', fixtures: 0, matches: 0, staleReason: 'no data', eloOnly: true },
    ],
    sources: { clubElo: { status: 'ok', detail: '' }, apiFootball: { status: 'off', detail: 'API_FOOTBALL_KEY is not set' } },
  };
  const md = renderSummary(index);
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Πρωτάθλημα'));
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 5, row);
  assert.match(rows[0], /Premier League \(PL\) \| ✅ ΟΚ \| 9 από 10 \| {2}\|$/);
  assert.match(rows[1], /Champions League \(CL\) \| ✅ ΟΚ \| 8 από 9 \| μόνο βαθμολογία Elo \(χαμηλότερη βεβαιότητα\) \|$/);
  assert.doesNotMatch(rows[2], /μόνο βαθμολογία Elo/, 'a failed league only shows its error');
  assert.match(md, /apiFootball ⏸️ ανενεργό \(API_FOOTBALL_KEY is not set\)/);
});

test('job-summary script appends to $GITHUB_STEP_SUMMARY and prints nothing when the index is missing', async () => {
  const work = newWorkspace();
  const out = path.join(work, 'data-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(sampleIndex));
  const summaryFile = path.join(work, 'summary.md');
  const r = await runScript(SUMMARY_SCRIPT, [], { env: { GITHUB_STEP_SUMMARY: summaryFile }, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /Premier League \(PL\)/);

  const empty = newWorkspace();
  const r2 = await runScript(SUMMARY_SCRIPT, [], { env: { GITHUB_STEP_SUMMARY: path.join(empty, 's.md') }, cwd: empty });
  assert.equal(r2.code, 0);
  assert.ok(!fs.existsSync(path.join(empty, 's.md')));
});
