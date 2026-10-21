// Daily pipeline entry point.
//   node scripts/refresh.mjs
// Environment: FOOTBALL_DATA_TOKEN (required), PREV_DIR (default data-prev),
// OUT_DIR (default data-out), FP_ONLY="PL,BL1" (optional, for debugging).
// Secrets are read from the environment and never printed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRefresh } from '../src/pipeline/refresh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.env.FP_ONLY ? process.env.FP_ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;

const result = await runRefresh({
  prevDir: path.resolve(process.env.PREV_DIR || 'data-prev'),
  outDir: path.resolve(process.env.OUT_DIR || 'data-out'),
  aliasesPath: path.join(root, 'aliases.json'),
  only,
});
process.exit(result.exitCode);
