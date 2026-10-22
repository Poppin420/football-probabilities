#!/usr/bin/env node
// Read-only diagnostics for one league (default ELC): own Elo without / with the second tiers, promoted vs
// established clubs, ceiling of predictability. Publishes NOTHING; the result is only the job summary.
//   node scripts/lab-elo.mjs          (env: PREV_DIR=data-prev, OUT_DIR=lab-out, FP_LAB_LEAGUE=ELC)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLab, runLab } from '../src/pipeline/lab.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const lab = await runLab({
    prevDir: path.resolve(process.env.PREV_DIR || 'data-prev'),
    outDir: path.resolve(process.env.OUT_DIR || 'lab-out'),
    aliasesPath: path.join(root, 'aliases.json'),
    code: process.env.FP_LAB_LEAGUE || 'ELC',
  });
  const md = renderLab(lab);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
} catch (err) {
  console.error(`Lab failed: ${err.stack || err.message}`);
  process.exit(1);
}
