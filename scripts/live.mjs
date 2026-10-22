#!/usr/bin/env node
// Live panel data: one request to football-data.org -> live-out/live.json (published to the branch "live" by
// scripts/data-branch.mjs with DATA_BRANCH=live). Does nothing (publish=false) when nothing changed since the last run.
//   node scripts/live.mjs        (env: FOOTBALL_DATA_TOKEN, PREV_DIR=live-prev, OUT_DIR=live-out)
import fs from 'node:fs';
import path from 'node:path';
import { createFdOrgClient } from '../src/sources/footballDataOrg.js';
import { buildLiveFile, liveWindow, sameLive } from '../src/pipeline/live.js';
import { currentTime } from '../src/config.js';

const prevDir = path.resolve(process.env.PREV_DIR || 'live-prev');
const outDir = path.resolve(process.env.OUT_DIR || 'live-out');
const setOutput = (publish) => {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
};

try {
  if (!process.env.FOOTBALL_DATA_TOKEN) throw new Error('FOOTBALL_DATA_TOKEN is not set');
  const now = currentTime();
  const client = createFdOrgClient({ token: process.env.FOOTBALL_DATA_TOKEN });
  const { from, to } = liveWindow(now);
  const { matches } = await client.matchesBetween(from, to);
  const live = buildLiveFile(matches, now);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(path.join(prevDir, 'live.json'), 'utf8'));
  } catch {
    prev = null;
  }
  console.log(`${matches.length} matches between ${from} and ${to}; ${live.matches.length} live or just finished.`);
  if (sameLive(prev, live)) {
    console.log('Nothing changed since the last run: nothing is published.');
    setOutput(false);
  } else {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'live.json'), JSON.stringify(live));
    setOutput(true);
  }
} catch (err) {
  // never print the key; the message of the client holds no secrets
  console.error(`::error::Live panel: ${String(err.message).slice(0, 300)}`);
  setOutput(false);
  process.exit(1);
}
