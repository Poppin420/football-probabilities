// Small file cache that lives in the "data" branch next to the published
// JSON. Each run reads the previous branch content (prevDir) and writes the
// next one (outDir). Cache files are gzip-compressed JSON, so they stay small
// in the repository: <outDir>/cache/<name>.json.gz

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function ageHours(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 3600000;
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Round numbers to 6 decimals to keep the files small.
  const text = JSON.stringify(obj, (_k, v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v));
  fs.writeFileSync(file, text);
}

export function createCache(prevDir, outDir) {
  const prevPath = (name) => path.join(prevDir, 'cache', `${name}.json.gz`);
  const outPath = (name) => path.join(outDir, 'cache', `${name}.json.gz`);

  /** Previous value of a cache entry, or null. Does NOT keep it for the next run. */
  function peek(name) {
    try {
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(prevPath(name))).toString('utf8'));
    } catch {
      return null;
    }
  }

  /** Store a value for the next run. */
  function put(name, value) {
    fs.mkdirSync(path.dirname(outPath(name)), { recursive: true });
    fs.writeFileSync(outPath(name), zlib.gzipSync(Buffer.from(JSON.stringify(value))));
  }

  /**
   * Copy the previous cache files that this run did not rewrite itself, when
   * keep(name) says they are still useful. The data branch is replaced by ONE new
   * commit every time, so anything a job does not carry over is lost.
   */
  function carryOver(keep) {
    let dir;
    try {
      dir = fs.readdirSync(path.join(prevDir, 'cache'));
    } catch {
      return 0;
    }
    let copied = 0;
    for (const file of dir) {
      const m = /^(.+)\.json\.gz$/.exec(file);
      if (!m || !keep(m[1])) continue;
      const target = outPath(m[1]);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(prevPath(m[1]), target);
      copied++;
    }
    return copied;
  }

  return { peek, put, outPath, prevPath, carryOver };
}

/** Copy every file of the previous branch content into the new output (except what `skip` rejects). */
export function copyTree(fromDir, toDir, skip = () => false, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(fromDir, rel), { withFileTypes: true });
  } catch {
    return 0;
  }
  let copied = 0;
  for (const e of entries) {
    if (e.name === '.git') continue;
    const r = path.join(rel, e.name);
    if (skip(r)) continue;
    if (e.isDirectory()) copied += copyTree(fromDir, toDir, skip, r);
    else {
      fs.mkdirSync(path.dirname(path.join(toDir, r)), { recursive: true });
      fs.copyFileSync(path.join(fromDir, r), path.join(toDir, r));
      copied++;
    }
  }
  return copied;
}
