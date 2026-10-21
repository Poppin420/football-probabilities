// Weekly tuning + back-test entry point (Phase 2).
//   node scripts/tune.mjs
// Reads the previous content of branch "data" (PREV_DIR, default data-prev),
// writes tune.json + report.json next to a copy of everything else (OUT_DIR,
// default data-out). Downloads only public CSV / ClubElo files: no secrets needed.
// Exit code 1 = a league is below the 8 % RPS limit (or nothing could be
// evaluated); the files are still written so the report can be published.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTune } from '../src/pipeline/tune.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.env.FP_ONLY ? process.env.FP_ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;
// Debug / test hook only (the workflow never sets it): number of bootstrap replicates of the
// final evaluation. report.json records the value that was used.
const k = Number(process.env.FP_BOOTSTRAP_K);
const bootstrapK = Number.isInteger(k) && k >= 1 && k <= 1000 ? k : undefined;

const result = await runTune({
  prevDir: path.resolve(process.env.PREV_DIR || 'data-prev'),
  outDir: path.resolve(process.env.OUT_DIR || 'data-out'),
  aliasesPath: path.join(root, 'aliases.json'),
  only,
  ...(bootstrapK ? { bootstrapK } : {}),
});
// Tell the workflow whether there is anything to publish.
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${result.publish}\n`);
process.exit(result.exitCode);
