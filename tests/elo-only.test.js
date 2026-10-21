import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, normal, poissonSample } from './helpers.js';
import { scoreMatrix } from '../src/model/poisson.js';
import { numericGradient } from '../src/model/optimize.js';
import {
  ELO_DIV, KAPPA_BOUNDS, eloOnlyLogLik, eloOnlyMeans, fitCupIntercept, fitEloOnly, fitEloOnlyRho, shrinkIntercept,
} from '../src/model/eloOnly.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

/** Simulated pooled sample: Elo difference ~ N(0, sd), goals from the Elo-only model. */
function simulate({ n = 8000, c = 0.25, eta = 0.22, kappa = 0.9, sd = 160, seed = 7, neutralShare = 0 }) {
  const rand = mulberry32(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const dE = sd * normal(rand);
    const neutral = rand() < neutralShare;
    const { lam, mu } = eloOnlyMeans({ c, eta, kappa }, dE, { neutral });
    rows.push({ x: poissonSample(rand, lam), y: poissonSample(rand, mu), d: dE / ELO_DIV, w: 1, neutral, dE });
  }
  return rows;
}

test('Elo-only: lam and mu follow the spec formula, mirror under swapping, and eta = 0 on neutral ground', () => {
  const p = { c: 0.2, eta: 0.25, kappa: 0.9 };
  const a = eloOnlyMeans(p, 200);
  near(a.lam, Math.exp(0.2 + 0.25 + 0.9 * 200 / 800), 1e-12, 'lam');
  near(a.mu, Math.exp(0.2 - 0.9 * 200 / 800), 1e-12, 'mu');
  const n1 = eloOnlyMeans(p, 200, { neutral: true });
  const n2 = eloOnlyMeans(p, -200, { neutral: true });
  near(n1.lam, n2.mu, 1e-12, 'neutral mirror lam/mu');
  near(n1.mu, n2.lam, 1e-12, 'neutral mirror mu/lam');
  const even = eloOnlyMeans(p, 0, { neutral: true });
  near(even.lam, even.mu, 1e-12, 'equal teams, neutral ground');
  assert.ok(eloOnlyMeans(p, 0).lam > eloOnlyMeans(p, 0).mu, 'home advantage');
});

test('Elo-only: the pooled regression recovers c, eta and kappa and its likelihood is maximal there', () => {
  const rows = simulate({});
  const fit = fitEloOnly(rows);
  assert.equal(fit.ok, true, fit.reason);
  near(fit.kappa, 0.9, 4 * fit.se.kappa, 'kappa');
  near(fit.eta, 0.22, 4 * fit.se.eta, 'eta');
  near(fit.c, 0.25, 4 * fit.se.c, 'c');
  assert.ok(fit.se.kappa > 0 && fit.se.kappa < 0.1, `se(kappa) ${fit.se.kappa}`);
  assert.equal(fit.converged, true);
  // the likelihood falls in every direction away from the optimum
  const th = [fit.c, fit.eta, fit.kappa];
  const base = eloOnlyLogLik(rows, th);
  for (let i = 0; i < 3; i++) {
    for (const step of [-0.02, 0.02]) {
      const t = th.slice();
      t[i] += step;
      assert.ok(eloOnlyLogLik(rows, t) < base, `direction ${i}${step}`);
    }
  }
  // the gradient vanishes at the optimum (numeric check)
  const g = numericGradient((v) => eloOnlyLogLik(rows, v), Float64Array.from(th), 1e-5);
  for (const v of g) assert.ok(Math.abs(v) < 0.05, `gradient ${v}`);
});

test('Elo-only: weights behave like repeated rows', () => {
  const rows = simulate({ n: 2500, seed: 3 });
  const doubled = [...rows, ...rows];
  const weighted = rows.map((r) => ({ ...r, w: 2 }));
  const a = fitEloOnly(doubled, { minRows: 100 });
  const b = fitEloOnly(weighted, { minRows: 100 });
  near(a.kappa, b.kappa, 1e-6, 'kappa');
  near(a.eta, b.eta, 1e-6, 'eta');
  near(a.c, b.c, 1e-6, 'c');
});

test('Elo-only: refuses too few matches and an implausible slope', () => {
  const few = fitEloOnly(simulate({ n: 400 }));
  assert.equal(few.ok, false);
  assert.match(few.reason, /only 400 matches/);
  const flat = fitEloOnly(simulate({ kappa: 0.0, seed: 11 }));
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /implausible Elo slope/);
  assert.ok(KAPPA_BOUNDS[0] > 0);
});

test('Elo-only: the cup intercept is recovered with kappa and eta fixed, also with neutral-ground matches', () => {
  const cup = simulate({ n: 6000, c: 0.33, eta: 0.22, kappa: 0.9, seed: 21, neutralShare: 0.2 });
  const r = fitCupIntercept(cup, { eta: 0.22, kappa: 0.9 });
  near(r.c, 0.33, 0.03, 'cup c');
  assert.equal(r.n, 6000);
  // ignoring that some matches are neutral would bias the intercept
  const wrong = fitCupIntercept(cup.map((x) => ({ ...x, neutral: false })), { eta: 0.22, kappa: 0.9 });
  assert.ok(Math.abs(wrong.c - 0.33) > Math.abs(r.c - 0.33), 'neutral flag matters');
  assert.equal(fitCupIntercept([{ x: 0, y: 0, d: 0, w: 1 }], { eta: 0.2, kappa: 0.9 }), null);
});

test('Elo-only: the shrunk intercept is a weighted mean of the cup and the domestic intercept', () => {
  const half = shrinkIntercept({ cCup: 0.4, wSum: 100, cBase: 0.2, n0: 100 });
  near(half.c, 0.3, 1e-12, 'half-half');
  near(half.weight, 0.5, 1e-12, 'weight');
  const none = shrinkIntercept({ cCup: null, wSum: 0, cBase: 0.2 });
  assert.equal(none.c, 0.2);
  assert.equal(none.weight, 0);
  const lots = shrinkIntercept({ cCup: 0.4, wSum: 100000, cBase: 0.2, n0: 100 });
  near(lots.c, 0.4, 1e-3, 'lots of cup data');
});

test('Elo-only: rho of the low-score correction is recovered from simulated Dixon-Coles scores', () => {
  const rand = mulberry32(5);
  const p = { c: 0.2, eta: 0.2, kappa: 0.9 };
  const rows = [];
  for (let i = 0; i < 12000; i++) {
    const dE = 150 * normal(rand);
    const { lam, mu } = eloOnlyMeans(p, dE);
    const M = scoreMatrix(lam, mu, -0.12);
    let u = rand();
    let hit = [0, 0];
    outer: for (let a = 0; a < M.size; a++) {
      for (let b = 0; b < M.size; b++) {
        u -= M.p[a * M.size + b];
        if (u <= 0) {
          hit = [a, b];
          break outer;
        }
      }
    }
    rows.push({ x: hit[0], y: hit[1], d: dE / ELO_DIV, w: 1 });
  }
  const r = fitEloOnlyRho(rows, p);
  assert.equal(r.feasible, true);
  near(r.rho, -0.12, 0.04, 'rho');
});
