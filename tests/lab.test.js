// The read-only Elo laboratory: with the second tiers the promoted clubs get a rating, nothing is published,
// and the second tiers stay out of the production pool unless ELO_TIERS=on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, normal, poissonSample } from './helpers.js';

process.env.CSV_PAUSE_MS = '0';
const { runLab, renderLab, splitPromoted } = await import('../src/pipeline/lab.js');
const { eloPoolLeagues } = await import('../src/config.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const NOW = new Date('2026-10-19T03:37:00Z');
const quiet = { log() {}, warn() {}, error() {} };
const tmp = (l) => fs.mkdtempSync(path.join(os.tmpdir(), `fp-lab-${l}-`));

/** Championship = teams T[4k..4k+19], League One = T[4k+20..4k+43]: 4 clubs per year move up from League One. */
function world() {
  const rand = mulberry32(5);
  const quality = Array.from({ length: 80 }, () => 0.45 * normal(rand));
  const memo = new Map();
  return async (div, code) => {
    if (div !== 'E1' && div !== 'E2') return { missing: true, rows: [] };
    const key = `${div}${code}`;
    if (!memo.has(key)) {
      const y = 2000 + Number(code.slice(0, 2));
      const k = y - 2018;
      const ids = Array.from({ length: div === 'E1' ? 20 : 24 }, (_, i) => 4 * k + i + (div === 'E1' ? 0 : 20));
      const day0 = Date.UTC(y, 7, 10) / 86400000;
      const pairs = [];
      for (const h of ids) for (const a of ids) if (h !== a) pairs.push([h, a]);
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
      const rows = pairs.map(([h, a], n) => {
        const t = day0 + Math.floor((n / pairs.length) * 270);
        return {
          date: new Date(t * 86400000).toISOString().slice(0, 10), t,
          home: `Club ${String.fromCharCode(65 + (h % 26))}${Math.floor(h / 26)}`, away: `Club ${String.fromCharCode(65 + (a % 26))}${Math.floor(a / 26)}`,
          x: poissonSample(rand, Math.exp(0.25 + quality[h] - quality[a] / 2)), y: poissonSample(rand, Math.exp(quality[a] - quality[h] / 2)),
          hthg: null, htag: null, hs: null, as: null, hst: null, ast: null, hc: null, ac: null, hy: null, ay: null, hr: null, ar: null, referee: null,
        };
      });
      memo.set(key, { missing: false, rows });
    }
    return memo.get(key);
  };
}

test('the second tiers are outside the production pool unless ELO_TIERS=on', () => {
  const codes = (o) => eloPoolLeagues(o).map((l) => l.code);
  assert.ok(!codes({ withTiers: false }).includes('E2'));
  assert.ok(codes({ withTiers: true }).includes('E2'));
  assert.ok(codes({ withTiers: true }).includes('F2'));
  assert.ok(codes({ withTiers: false }).includes('ELC'));
});

test('lab: runs on the Championship, rates promoted clubs only with the tiers, publishes nothing', async () => {
  const prev = tmp('prev');
  const out = tmp('out');
  const lab = await runLab({ prevDir: prev, outDir: out, aliasesPath: ALIASES, now: NOW, logger: quiet, code: 'ELC', sleepFn: async () => {}, fetchCsv: world() });
  assert.equal(lab.league, 'ELC');
  for (const k of ['noElo', 'ownElo', 'ownEloTiers']) {
    assert.ok(lab.variants[k].all.n > 500, `${k} n ${lab.variants[k].all.n}`);
    assert.ok(Number.isFinite(lab.variants[k].all.rps));
    assert.equal(lab.variants[k].promoted.n + lab.variants[k].established.n, lab.variants[k].all.n);
  }
  assert.ok(lab.variants.ownElo.promoted.n > 0);
  const plain = lab.variants.ownElo.coverage.reduce((s, c) => s + c.promotedRated, 0);
  const tiers = lab.variants.ownEloTiers.coverage.reduce((s, c) => s + c.promotedRated, 0);
  const all = lab.variants.ownElo.coverage.reduce((s, c) => s + c.promoted, 0);
  assert.ok(all > 0 && tiers > plain, `rated promoted clubs: ${plain} without, ${tiers} with the tiers (of ${all})`);
  assert.ok(Number.isFinite(lab.ceiling.rps) && lab.ceiling.rps > 0);
  assert.ok(fs.existsSync(path.join(out, 'lab.json')));
  assert.ok(!fs.existsSync(path.join(out, 'report.json')) && !fs.existsSync(path.join(out, 'tune.json')), 'nothing of production is written');
  const md = renderLab(lab);
  assert.match(md, /Εργαστήριο Elo - ELC/);
  assert.match(md, /Συμπέρασμα/);
  assert.match(md, /\| Δικό μας Elo \+ δεύτερες κατηγορίες \|/);
});

test('lab: an unknown league is an error; splitPromoted needs a full previous season', async () => {
  await assert.rejects(runLab({ prevDir: tmp('p2'), outDir: tmp('o2'), aliasesPath: ALIASES, now: NOW, logger: quiet, code: 'E2', fetchCsv: world() }), /unknown or disabled/);
  const rows = [];
  assert.deepEqual(splitPromoted([], rows).promoted, []);
  assert.equal(splitPromoted([], rows).isPromoted(2025, 'x'), false);
});
