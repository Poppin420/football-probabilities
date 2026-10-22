#!/usr/bin/env node
// Helpers for the "data" branch, used by the GitHub Actions workflows.
//
//   node scripts/data-branch.mjs fetch     download the current "data" branch into data-prev/
//   node scripts/data-branch.mjs publish   publish data-out/ as ONE fresh orphan commit (force-push)
//
// Why an orphan commit: the branch always holds exactly one commit, so the
// repository does not grow with every run, and "main" (which Netlify watches)
// is never touched.
//
// Environment (all optional in Actions, where GITHUB_REPOSITORY is set):
//   DATA_REMOTE    git URL of the repository (default: <server>/<GITHUB_REPOSITORY>.git)
//   DATA_BRANCH    branch name (default: data; "main"/"master" are refused)
//   PREV_DIR       default data-prev          OUT_DIR   default data-out
//   GITHUB_TOKEN   used only for https remotes, sent as an HTTP header, never printed
//   GIT_RETRY_DELAY_MS   pause between the 3 attempts of a network operation (default 5000)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const FORBIDDEN_BRANCHES = new Set(['main', 'master', 'HEAD']);
const OPTIONAL_JSON = ['tune.json', 'report.json', 'ai-cache.json'];

const README = `# Branch "data"

This branch is generated automatically by the GitHub Actions workflow
"Ανανέωση δεδομένων". Do not edit it by hand: every run replaces the whole
branch with one fresh commit.

The web page reads \`index.json\` and one \`<LEAGUE>.json\` file per league from here,
and \`report.json\` for the tab "Αξιοπιστία".
\`tune.json\` (parameters chosen by the weekly back-test) and \`ai-cache.json\`
(Greek comments already written) are used by the next run.
The \`cache/\` folder holds compressed copies of downloaded source data so that
the next run does not have to download everything again.
`;

// Netlify must never build this branch (it contains only JSON). The page itself
// is deployed from "main"; this file is a safety net in case branch deploys are on.
const NETLIFY_TOML = `# Generated. This branch only holds data files, never build it.
[build]
  ignore = "exit 0"
`;

export function settingsFromEnv(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const remote = env.DATA_REMOTE || (repo ? `${server}/${repo}.git` : '');
  if (!remote) throw new Error('Set DATA_REMOTE (or run inside GitHub Actions, where GITHUB_REPOSITORY is set).');
  const branch = env.DATA_BRANCH || 'data';
  if (!/^[A-Za-z0-9._-]+$/.test(branch) || FORBIDDEN_BRANCHES.has(branch) || branch === env.GITHUB_REF_NAME) {
    throw new Error(`Refusing to use "${branch}" as the data branch: publishing replaces the whole branch, it must never be a source branch.`);
  }
  return {
    remote,
    branch,
    prevDir: path.resolve(env.PREV_DIR || 'data-prev'),
    outDir: path.resolve(env.OUT_DIR || 'data-out'),
    token: env.GITHUB_TOKEN || '',
    partialRun: Boolean(env.FP_ONLY),
    retryDelayMs: Number(env.GIT_RETRY_DELAY_MS ?? 5000),
    inActions: env.GITHUB_ACTIONS === 'true',
    runUrl: repo && env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : '',
  };
}

/** Git config (through environment variables) that authenticates https requests. Nothing is stored on disk. */
export function authEnv(remote, token) {
  if (!token || !/^https:\/\//i.test(remote)) return {};
  const origin = new URL(remote).origin;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function scrub(text, token) {
  let out = String(text);
  if (token) {
    out = out.split(token).join('***');
    out = out.split(Buffer.from(`x-access-token:${token}`).toString('base64')).join('***');
  }
  return out.replace(/\/\/[^/@\s]+@/g, '//***@');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function git(settings, args, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...authEnv(settings.remote, settings.token) },
    });
    return stdout;
  } catch (err) {
    const detail = scrub(String(err.stderr || err.message || '').trim(), settings.token);
    throw new Error(`git ${args[0]} failed: ${detail.split('\n').slice(0, 6).join(' | ')}`);
  }
}

/** Run a network operation up to 3 times. Only transient problems should ever need the retries. */
async function withRetry(settings, label, fn) {
  const attempts = 3;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`${label}: attempt ${i} of ${attempts} failed (${err.message.slice(0, 200)}), trying again`);
      await sleep(settings.retryDelayMs);
    }
  }
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Download the previous content of the data branch. A missing branch (first run) gives an empty folder. */
export async function fetchPrevious(settings) {
  const { remote, branch, prevDir } = settings;
  fs.rmSync(prevDir, { recursive: true, force: true });
  // Only a SUCCESSFUL listing without our branch means "first run". A network or permission
  // error must stop the job: publishing after a failed download would erase the old data.
  const listing = await withRetry(settings, 'ls-remote', () => git(settings, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]));
  if (!listing.trim()) {
    fs.mkdirSync(prevDir, { recursive: true });
    console.log(`No "${branch}" branch yet (first run): starting with an empty ${path.basename(prevDir)}/ folder.`);
    return { existed: false, files: 0 };
  }
  await withRetry(settings, 'clone', async () => {
    fs.rmSync(prevDir, { recursive: true, force: true });
    await git(settings, ['clone', '--quiet', '--depth', '1', '--branch', branch, '--single-branch', remote, prevDir]);
  });
  fs.rmSync(path.join(prevDir, '.git'), { recursive: true, force: true });
  const files = listFiles(prevDir).length;
  console.log(`Restored ${files} files from branch "${branch}" into ${path.basename(prevDir)}/.`);
  return { existed: true, files };
}

/** Refuse to publish anything that looks incomplete: a broken publish would replace good data. */
export function checkOutput(settings) {
  const { outDir, partialRun } = settings;
  if (settings.branch === 'live') {
    // the tiny branch of the live panel: one file, nothing else to protect
    let live;
    try {
      live = JSON.parse(fs.readFileSync(path.join(outDir, 'live.json'), 'utf8'));
    } catch {
      throw new Error(`${path.basename(outDir)}/live.json is missing or is not valid JSON: nothing was published.`);
    }
    if (live?.schema !== 1 || !Array.isArray(live.matches)) throw new Error('live.json has an unexpected shape: nothing was published.');
    return { generatedAt: live.updatedAt };
  }
  if (partialRun) {
    throw new Error('FP_ONLY is set: a partial run must never be published, it would delete the other leagues.');
  }
  const indexFile = path.join(outDir, 'index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {
    throw new Error(`${path.basename(outDir)}/index.json is missing or is not valid JSON: nothing was published.`);
  }
  if (index?.schema !== 1 || !Array.isArray(index.leagues) || index.leagues.length === 0) {
    throw new Error('index.json has an unexpected shape (schema 1 with a non-empty "leagues" list is required): nothing was published.');
  }
  for (const l of index.leagues) {
    if (!l.file) continue;
    if (!/^[A-Za-z0-9_]+\.json$/.test(l.file)) throw new Error(`index.json lists an unsafe file name "${l.file}": nothing was published.`);
    const file = path.join(outDir, l.file);
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${l.file} is listed in index.json but is missing or is not valid JSON: nothing was published.`);
    }
  }
  // Optional files (written by the weekly tuning and the Greek-comment step): when present they must be
  // valid JSON, because the next run reads them and the page fetches report.json.
  for (const name of OPTIONAL_JSON) {
    const file = path.join(outDir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    } catch {
      throw new Error(`${name} is not valid JSON: nothing was published.`);
    }
  }
  return index;
}

/** Publish outDir as a single new root commit on the data branch (force-push). */
export async function publishOutput(settings) {
  const { remote, branch, outDir } = settings;
  const index = checkOutput(settings);
  fs.writeFileSync(path.join(outDir, 'README.md'), README);
  fs.writeFileSync(path.join(outDir, 'netlify.toml'), NETLIFY_TOML);
  fs.rmSync(path.join(outDir, '.git'), { recursive: true, force: true });

  await git(settings, ['init', '--quiet'], { cwd: outDir });
  await git(settings, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: outDir });
  await git(settings, ['add', '--all'], { cwd: outDir });
  const message = [`Data ${index.generatedAt || new Date().toISOString()}`, settings.runUrl ? `\n${settings.runUrl}` : ''].join('');
  await git(settings, ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', message], { cwd: outDir });
  await withRetry(settings, 'push', () => git(settings, ['push', '--force', '--quiet', remote, `HEAD:refs/heads/${branch}`], { cwd: outDir }));

  const sha = (await git(settings, ['rev-parse', '--short', 'HEAD'], { cwd: outDir })).trim();
  const files = listFiles(outDir).filter((f) => !f.includes(`${path.sep}.git${path.sep}`));
  const kb = Math.round(files.reduce((sum, f) => sum + fs.statSync(f).size, 0) / 1024);
  console.log(`Published ${files.length} files (${kb} KB) to branch "${branch}" as one commit (${sha}).`);
  return { sha, files: files.length, kb };
}

async function main() {
  const command = process.argv[2];
  if (command !== 'fetch' && command !== 'publish') {
    console.error('Usage: node scripts/data-branch.mjs fetch|publish');
    process.exit(2);
  }
  let settings = null;
  try {
    settings = settingsFromEnv();
    if (settings.inActions && settings.token) {
      const basic = Buffer.from(`x-access-token:${settings.token}`).toString('base64');
      console.log(`::add-mask::${basic}`); // the token itself is masked by GitHub; this is the encoded form
    }
    if (command === 'fetch') await fetchPrevious(settings);
    else await publishOutput(settings);
  } catch (err) {
    const message = scrub(err.message, settings?.token);
    console.error(settings?.inActions ? `::error::${message}` : `ERROR: ${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
