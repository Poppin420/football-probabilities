import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatrix, poissonPmf } from '../src/model/poisson.js';
import { goalMarkets } from '../src/model/markets.js';
import {
  HTFT_KEYS, estimateHalfShare, halfTimeMarkets, htBaseRates, htftIndex, htOutcomeIndex,
} from '../src/model/htft.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const sum = (a) => a.reduce((s, v) => s + v, 0);

test('HT/FT: nine probabilities sum to 1 and reproduce the full-time 1X2 exactly', () => {
  for (const [lam, mu, rho, s] of [[1.35, 1.35, 0, 0.45], [2.1, 0.7, -0.1, 0.447], [0.6, 1.9, -0.05, 0.4], [3.4, 2.8, 0.05, 0.5]]) {
    const M = scoreMatrix(lam, mu, rho);
    const mk = halfTimeMarkets(M, s);
    const g = goalMarkets(M);
    near(sum(mk.htft), 1, 1e-12, 'sum');
    near(mk.ht.home + mk.ht.draw + mk.ht.away, 1, 1e-12, 'ht sum');
    // column sums = full-time result
    const ft = [0, 0, 0];
    for (let i = 0; i < 9; i++) ft[i % 3] += mk.htft[i];
    near(ft[0], g.oneX2.home, 1e-12, 'FT home');
    near(ft[1], g.oneX2.draw, 1e-12, 'FT draw');
    near(ft[2], g.oneX2.away, 1e-12, 'FT away');
    assert.ok(mk.htft.every((p) => p >= 0));
  }
});

test('HT/FT: with independent Poisson goals the first half is Poisson(s * (lam + mu)) and the two halves are independent', () => {
  const lam = 1.6;
  const mu = 1.1;
  const s = 0.45;
  const M = scoreMatrix(lam, mu, 0);
  const mk = halfTimeMarkets(M, s);
  // 0-0 at half-time
  near(mk.firstHalf.totals[0].under, Math.exp(-s * (lam + mu)), 1e-7, 'P(no first-half goal)');
  near(mk.firstHalf.mean, s * (lam + mu), 1e-7, 'mean first-half goals');
  // brute force: four independent Poisson variables (halves x teams)
  const K = 13;
  const joint = new Array(9).fill(0);
  const out = (a, b) => (a > b ? 0 : a === b ? 1 : 2);
  for (let h1 = 0; h1 < K; h1++) {
    for (let a1 = 0; a1 < K; a1++) {
      const p1 = poissonPmf(h1, s * lam) * poissonPmf(a1, s * mu);
      for (let h2 = 0; h2 < K; h2++) {
        for (let a2 = 0; a2 < K; a2++) {
          const p = p1 * poissonPmf(h2, (1 - s) * lam) * poissonPmf(a2, (1 - s) * mu);
          joint[3 * out(h1, a1) + out(h1 + h2, a1 + a2)] += p;
        }
      }
    }
  }
  for (let i = 0; i < 9; i++) near(mk.htft[i], joint[i], 1e-6, `combination ${HTFT_KEYS[i]}`);
});

test('HT/FT: limits s -> 0 (all goals late) and s -> 1 (all goals early)', () => {
  const M = scoreMatrix(1.5, 1.2, -0.08);
  const g = goalMarkets(M);
  const late = halfTimeMarkets(M, 1e-9);
  near(late.ht.draw, 1, 1e-6, 'HT is 0-0');
  near(late.htft[3], g.oneX2.home, 1e-6, 'X/1');
  near(late.htft[4], g.oneX2.draw, 1e-6, 'X/X');
  const early = halfTimeMarkets(M, 1 - 1e-9);
  near(early.htft[0], g.oneX2.home, 1e-6, '1/1');
  near(early.htft[4], g.oneX2.draw, 1e-6, 'X/X');
  near(early.htft[8], g.oneX2.away, 1e-6, '2/2');
  for (const i of [1, 2, 3, 5, 6, 7]) near(early.htft[i], 0, 1e-6, `${HTFT_KEYS[i]} impossible`);
});

test('HT/FT: swapping the teams mirrors the nine combinations', () => {
  const a = halfTimeMarkets(scoreMatrix(1.9, 0.8, -0.1), 0.44);
  const b = halfTimeMarkets(scoreMatrix(0.8, 1.9, -0.1), 0.44);
  const mirror = { 0: 8, 1: 7, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 0 }; // 1/1 <-> 2/2, 1/X <-> 2/X, ...
  for (let i = 0; i < 9; i++) near(a.htft[i], b.htft[mirror[i]], 1e-12, HTFT_KEYS[i]);
});

test('HT/FT: a leader at half-time usually wins; the favourite is most likely 1/1', () => {
  const mk = halfTimeMarkets(scoreMatrix(2.2, 0.8, -0.05), 0.447);
  assert.equal(mk.htft.indexOf(Math.max(...mk.htft)), 0, 'most likely: home leads and wins');
  assert.ok(mk.htft[0] > mk.htft[2] * 5, '1/1 far above 1/2');
  assert.ok(mk.ht.home > mk.ht.away);
});

test('first-half over lines are consistent with the pmf of first-half goals', () => {
  const mk = halfTimeMarkets(scoreMatrix(1.4, 1.2, 0), 0.45);
  const lam1 = 0.45 * 2.6;
  near(mk.firstHalf.totals[0].over, 1 - Math.exp(-lam1), 1e-6, 'over 0.5');
  near(mk.firstHalf.totals[1].over, 1 - Math.exp(-lam1) * (1 + lam1), 1e-6, 'over 1.5');
  for (const t of mk.firstHalf.totals) near(t.over + t.under, 1, 1e-12, 'over + under');
});

test('estimateHalfShare: weighted ratio of half-time goals to full-time goals', () => {
  const rows = [];
  // 300 matches: 1 goal at half-time out of 2 for the home side, none for the away side -> share (1 + 0) / (2 + 1) = 1/3 ... use a clean ratio instead
  for (let i = 0; i < 300; i++) rows.push({ t: 100 + i % 50, x: 2, y: 2, hthg: 1, htag: 1 }); // share 2 / 4 = 0.5
  const ok = estimateHalfShare(rows, 1000, 0);
  assert.equal(ok.ok, true);
  near(ok.s, 0.5, 1e-12, 'share');
  assert.equal(ok.n, 300);
  // impossible half-time scores and rows from the future are ignored
  const dirty = [...rows, { t: 120, x: 1, y: 0, hthg: 2, htag: 0 }, { t: 5000, x: 3, y: 3, hthg: 0, htag: 0 }, { t: 130, x: 1, y: 1, hthg: null, htag: null }];
  const same = estimateHalfShare(dirty, 1000, 0);
  near(same.s, 0.5, 1e-12, 'dirty rows ignored');
  assert.equal(same.n, 300);
  // too few matches
  const few = estimateHalfShare(rows.slice(0, 50), 1000, 0);
  assert.equal(few.ok, false);
  assert.match(few.reason, /only 50 matches/);
  // implausible share
  const bad = estimateHalfShare(rows.map((r) => ({ ...r, hthg: 0, htag: 0 })), 1000, 0);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /implausible/);
});

test('estimateHalfShare: recent matches weigh more', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ t: 100, x: 5, y: 4, hthg: 2, htag: 2 }); // old: share 4 / 9
  for (let i = 0; i < 300; i++) rows.push({ t: 990, x: 5, y: 4, hthg: 3, htag: 2 }); // recent: share 5 / 9
  const flat = estimateHalfShare(rows, 1000, 0);
  const decayed = estimateHalfShare(rows, 1000, 0.0019);
  near(flat.s, 0.5, 1e-12, 'no decay');
  assert.ok(decayed.ok && decayed.s > 0.53, `decay favours the recent matches (${decayed.s})`);
});

test('base rates and index helpers', () => {
  const train = [];
  for (let i = 0; i < 100; i++) train.push({ x: 2, y: 1, hthg: 1, htag: 0 }); // 1/1
  for (let i = 0; i < 50; i++) train.push({ x: 0, y: 0, hthg: 0, htag: 0 }); // X/X
  const b = htBaseRates(train);
  near(sum(b.ht), 1, 1e-12, 'ht base');
  near(sum(b.joint), 1, 1e-12, 'joint base');
  assert.ok(b.joint[0] > b.joint[4] && b.joint[4] > b.joint[8]);
  assert.equal(htftIndex(1, 0, 2, 1), 0);
  assert.equal(htftIndex(0, 0, 1, 0), 3);
  assert.equal(htftIndex(0, 1, 0, 2), 8);
  assert.equal(htOutcomeIndex(2, 1), 0);
  assert.equal(htOutcomeIndex(1, 1), 1);
  assert.equal(htOutcomeIndex(0, 1), 2);
});
