import test from 'node:test';
import assert from 'node:assert/strict';
import { nbPmf, nbPmfArray, convolve, tailOver, pmfMean, fitNegBinTwoSided } from '../src/model/negbin.js';
import { poissonPmfArray } from '../src/model/poisson.js';
import { cornerMarkets, cardMarkets } from '../src/model/markets.js';
import { redPmf, weightedCorr } from '../src/model/counts.js';
import { mulberry32, normal, nbSample, poissonSample } from './helpers.js';

const sum = (a) => Array.from(a).reduce((s, v) => s + v, 0);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

test('Test 6: NegBin pmf sums to 1', () => {
  for (const [m, r] of [[5, 5], [4.8, 20], [2.1, 60], [10, 500]]) {
    let s = 0;
    for (let k = 0; k < 400; k++) s += nbPmf(k, m, r);
    near(s, 1, 1e-9, `sum for m=${m}, r=${r}`);
    near(sum(nbPmfArray(m, r, 40)), 1, 1e-12, 'normalised array');
  }
});

test('Test 6: NegBin mean and variance follow m and m + m^2/r', () => {
  const m = 5.2;
  const r = 18;
  let mean = 0;
  let second = 0;
  for (let k = 0; k < 400; k++) {
    const p = nbPmf(k, m, r);
    mean += k * p;
    second += k * k * p;
  }
  near(mean, m, 1e-8, 'mean');
  near(second - mean * mean, m + (m * m) / r, 1e-6, 'variance');
});

test('Test 6: NegBin tends to Poisson as r grows', () => {
  const m = 4.5;
  const pois = poissonPmfArray(m, 40);
  let prev = Infinity;
  for (const r of [10, 100, 1000, 100000]) {
    const nb = nbPmfArray(m, r, 40);
    let tv = 0;
    for (let k = 0; k <= 40; k++) tv += Math.abs(nb[k] - pois[k]) / 2;
    assert.ok(tv < prev, 'distance shrinks');
    prev = tv;
  }
  assert.ok(prev < 1e-3, `total variation distance ${prev}`);
});

test('Test 6: convolutions sum to 1 and have the right mean', () => {
  const a = nbPmfArray(5.1, 20, 40);
  const b = nbPmfArray(4.2, 20, 40);
  const t = convolve(a, b);
  near(sum(t), 1, 1e-12, 'convolution mass');
  near(pmfMean(t), pmfMean(a) + pmfMean(b), 1e-9, 'convolution mean');
  assert.equal(t.length, 81);
});

test('Corner and card market sets are complete', () => {
  const pH = nbPmfArray(5.6, 25, 40);
  const pA = nbPmfArray(4.4, 25, 40);
  const c = cornerMarkets(pH, pA);
  for (const t of c.totals) near(t.over + t.under, 1, 1e-12, `corner total ${t.line}`);
  near(c.more.home + c.more.equal + c.more.away, 1, 1e-12, 'more corners');
  for (const h of c.handicaps) near(h.win + h.lose, 1, 1e-12, `corner handicap ${h.line}`);
  near(c.mean.total, c.mean.home + c.mean.away, 1e-9, 'mean total');
  // monotone in the line
  for (let i = 1; i < c.totals.length; i++) assert.ok(c.totals[i].over < c.totals[i - 1].over);

  const cards = cardMarkets({
    yH: nbPmfArray(1.9, 40, 40),
    yA: nbPmfArray(2.1, 40, 40),
    rH: redPmf(0.05),
    rA: redPmf(0.06),
  });
  for (const t of cards.totals) near(t.over + t.under, 1, 1e-12, `cards total ${t.line}`);
  for (const t of cards.bookingPoints) near(t.over + t.under, 1, 1e-12, `booking points ${t.line}`);
  near(cards.mean.total, 1.9 + 2.1 + 0.05 + 0.06, 1e-6, 'cards mean');
});

test('NegBin GLM recovers the dispersion size from simulated data', () => {
  const rand = mulberry32(77);
  const nTeams = 20;
  const att = Array.from({ length: nTeams }, () => 0.15 * normal(rand));
  const def = Array.from({ length: nTeams }, () => 0.12 * normal(rand));
  const rTrue = 25;
  const rows = [];
  for (let rep = 0; rep < 3; rep++) {
    for (let h = 0; h < nTeams; h++) {
      for (let a = 0; a < nTeams; a++) {
        if (h === a) continue;
        const m1 = Math.exp(1.6 + 0.12 + att[h] + def[a]);
        const m2 = Math.exp(1.6 + att[a] + def[h]);
        rows.push({ h, a, x: nbSample(rand, m1, rTrue), y: nbSample(rand, m2, rTrue), w: 1 });
      }
    }
  }
  const res = fitNegBinTwoSided({ rows, nTeams, sigma: 0.2 });
  assert.equal(res.family, 'negbin');
  assert.ok(res.r > 14 && res.r < 50, `r = ${res.r}`);
  near(res.fit.eta, 0.12, 0.05, 'home advantage');
  for (let i = 1; i < res.fit.trace.length; i++) assert.ok(res.fit.trace[i] >= res.fit.trace[i - 1] - 1e-9);
});

test('Poisson-like counts switch the corner model to Poisson (r > 200)', () => {
  const rand = mulberry32(5);
  const nTeams = 12;
  const rows = [];
  for (let rep = 0; rep < 6; rep++) {
    for (let h = 0; h < nTeams; h++) {
      for (let a = 0; a < nTeams; a++) {
        if (h === a) continue;
        rows.push({ h, a, x: poissonSample(rand, 5), y: poissonSample(rand, 4), w: 1 });
      }
    }
  }
  const res = fitNegBinTwoSided({ rows, nTeams });
  assert.equal(res.family, 'poisson');
  assert.equal(res.r, Infinity);
  near(tailOver(nbPmfArray(5, res.r, 40), 4.5), 1 - poissonPmfArray(5, 4).reduce((s, v) => s + v, 0), 1e-9);
});

test('weightedCorr is 1 for identical series and -1 for opposite', () => {
  const x = [1, 2, 3, 4];
  near(weightedCorr(x, x, [1, 1, 1, 1]), 1, 1e-12);
  near(weightedCorr(x, x.map((v) => -v), [1, 2, 1, 2]), -1, 1e-12);
});
