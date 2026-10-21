// Bayesian bootstrap of the goals model (Phase 2).
//
// K refits of stage 1 AND stage 2, each with the match weights w_k multiplied
// by independent Exp(1) draws (Rubin's Bayesian bootstrap: Dirichlet weights
// up to a constant). For every fixture:
//   - the FINAL score matrix is the mean of the K replicate matrices
//     (posterior predictive), so every market is computed from it;
//   - the 10th / 90th percentile of 1X2, Over 2.5 and BTTS over the K
//     replicates are stored as the displayed range.
// Prior means, sigma and the responses stay fixed; only the weights change.

import { fitTwoSided } from './glm.js';
import { fitRho, predictLambdaMu } from './dc.js';
import { MAX_GOALS, scoreMatrix } from './poisson.js';
import { coreProbs } from './core.js';
import { exp1, mulberry32 } from './rng.js';

export const DEFAULT_K = 100;
export const RANGE_LEVELS = Object.freeze([0.1, 0.9]);

/** Quantile of a sorted array, linear interpolation between order statistics. */
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** One replicate: the fitted model object with the weights multiplied by `mult`. */
export function refitWeighted(base, mult, { tol = 1e-7 } = {}) {
  const rows = base.rows.map((r, k) => ({ h: r.h, a: r.a, x: r.x, y: r.y, w: r.w * mult[k] }));
  const fit = fitTwoSided({
    rows,
    nTeams: base.teams.length,
    sigma: base.sigma,
    mAtt: base.priorMeans.mAtt,
    mDef: base.priorMeans.mDef,
    theta0: base.theta,
    tol,
  });
  const model = { ...base, c: fit.c, eta: fit.eta, att: fit.att, def: fit.def, rows, converged: fit.converged };
  const rho = fitRho(model).rho;
  return { model, rho, converged: fit.converged };
}

/**
 * @param {object} p
 * @param {object} p.base        the point fit: fitGoals() result
 * @param {{home:string, away:string}[]} p.fixtures    team keys
 * @param {number} [p.K]
 * @param {number} p.seed
 * @param {(m: {size:number, p:Float64Array}) => {size:number, p:Float64Array}} [p.calibrate]
 *        applied to every replicate matrix (calibration layer) before anything is read from it
 * @returns {{ fixtures: object[], replicates: number, failed: number }}
 */
export function bootstrapForecasts({ base, fixtures, K = DEFAULT_K, seed, calibrate = null }) {
  const rand = mulberry32(seed);
  const nFix = fixtures.length;
  const size = MAX_GOALS + 1;
  const sums = fixtures.map(() => new Float64Array(size * size));
  const lamSum = new Float64Array(nFix);
  const muSum = new Float64Array(nFix);
  const rhoSum = new Float64Array(nFix);
  const draws = fixtures.map(() => ({ h: [], d: [], a: [], over: [], btts: [] }));
  let ok = 0;
  let failed = 0;

  for (let rep = 0; rep < K; rep++) {
    const mult = new Float64Array(base.rows.length);
    for (let k = 0; k < mult.length; k++) mult[k] = exp1(rand);
    let r;
    try {
      r = refitWeighted(base, mult);
    } catch {
      failed++; // a degenerate draw is skipped, never replaced by invented numbers
      continue;
    }
    ok++;
    for (let f = 0; f < nFix; f++) {
      const { lam, mu } = predictLambdaMu(r.model, fixtures[f].home, fixtures[f].away);
      let M = scoreMatrix(lam, mu, r.rho);
      if (calibrate) M = calibrate(M);
      const c = coreProbs(M);
      draws[f].h.push(c.pH);
      draws[f].d.push(c.pD);
      draws[f].a.push(c.pA);
      draws[f].over.push(c.pOver25);
      draws[f].btts.push(c.pBtts);
      const acc = sums[f];
      for (let i = 0; i < acc.length; i++) acc[i] += M.p[i];
      lamSum[f] += lam;
      muSum[f] += mu;
      rhoSum[f] += r.rho;
    }
  }
  if (ok === 0) throw new Error('Bayesian bootstrap: every replicate failed');

  const out = fixtures.map((_fx, f) => {
    const p = sums[f].map((v) => v / ok);
    const matrix = { size, p };
    const point = coreProbs(matrix);
    const range = (arr, value) => {
      const s = [...arr].sort((a, b) => a - b);
      const lo = Math.min(quantileSorted(s, RANGE_LEVELS[0]), value);
      const hi = Math.max(quantileSorted(s, RANGE_LEVELS[1]), value);
      return [lo, hi];
    };
    return {
      matrix,
      lam: lamSum[f] / ok,
      mu: muSum[f] / ok,
      rho: rhoSum[f] / ok,
      ranges: {
        oneX2: { home: range(draws[f].h, point.pH), draw: range(draws[f].d, point.pD), away: range(draws[f].a, point.pA) },
        over25: range(draws[f].over, point.pOver25),
        btts: range(draws[f].btts, point.pBtts),
      },
    };
  });
  return { fixtures: out, replicates: ok, failed };
}
