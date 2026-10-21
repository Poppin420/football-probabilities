// Negative binomial distribution, convolutions and the NegBin two-sided GLM
// (corners, yellow cards).
//
//   P(k) = Gamma(k + r) / (k! Gamma(r)) * (r / (r + m))^r * (m / (r + m))^k
//   Var  = m + m^2 / r

import { fitTwoSided, fittedMeans, nbLogPmf } from './glm.js';
import { goldenSection } from './optimize.js';
import { poissonPmfArray } from './poisson.js';

export function nbPmf(k, m, r) {
  if (!(m > 0)) return k === 0 ? 1 : 0;
  return Math.exp(nbLogPmf(k, m, r));
}

/**
 * pmf for k = 0..maxK, truncated and renormalised so it sums to exactly 1.
 * r = Infinity (or a very large r) falls back to the Poisson pmf.
 */
export function nbPmfArray(m, r, maxK) {
  if (!Number.isFinite(r)) return normalise(poissonPmfArray(m, maxK));
  const out = new Float64Array(maxK + 1);
  const q = m / (r + m);
  out[0] = Math.pow(r / (r + m), r);
  for (let k = 0; k < maxK; k++) out[k + 1] = (out[k] * (k + r) * q) / (k + 1);
  return normalise(out);
}

export function normalise(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i];
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / s;
  return out;
}

/** Exact convolution of two pmfs (distribution of the sum). */
export function convolve(p, q) {
  const out = new Float64Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue;
    for (let j = 0; j < q.length; j++) out[i + j] += p[i] * q[j];
  }
  return out;
}

/** P(T > line) for a pmf over 0..n and a half-integer (or any) line. */
export function tailOver(pmf, line) {
  let s = 0;
  for (let k = 0; k < pmf.length; k++) if (k > line) s += pmf[k];
  return s;
}

export function pmfMean(pmf) {
  let s = 0;
  for (let k = 0; k < pmf.length; k++) s += k * pmf[k];
  return s;
}

export const R_BOUNDS = [5, 500];
export const POISSON_ABOVE = 200;

/** Weighted profile log-likelihood in r for fixed fitted means. */
function profileLogLik(rows, m1, m2, r) {
  let s = 0;
  for (let k = 0; k < rows.length; k++) {
    s += rows[k].w * (nbLogPmf(rows[k].x, m1[k], r) + nbLogPmf(rows[k].y, m2[k], r));
  }
  return s;
}

/**
 * Fit the NegBin two-sided model. For fixed r this is a GLM solved by IRLS
 * (Fisher scoring with working weights m / (1 + m / r)); r is then updated by
 * a one-dimensional weighted profile likelihood on [5, 500] and the two
 * steps alternate until r stabilises. If r ends above 200 the model is
 * refitted as Poisson.
 */
export function fitNegBinTwoSided({
  rows,
  nTeams,
  sigma = 0.2,
  rInit = 30,
  maxRounds = 15,
  mAtt = null,
  mDef = null,
}) {
  let r = rInit;
  let fit = null;
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    fit = fitTwoSided({ rows, nTeams, sigma, mAtt, mDef, family: 'negbin', r, theta0: fit ? fit.theta : null });
    const { m1, m2 } = fittedMeans(fit, rows);
    const best = goldenSection(
      (lr) => profileLogLik(rows, m1, m2, Math.exp(lr)),
      Math.log(R_BOUNDS[0]),
      Math.log(R_BOUNDS[1]),
      1e-5,
    );
    const rNew = Math.exp(best.x);
    const done = Math.abs(Math.log(rNew) - Math.log(r)) < 1e-3;
    r = rNew;
    if (done) break;
  }
  const rRaw = r;
  if (r > POISSON_ABOVE) {
    fit = fitTwoSided({ rows, nTeams, sigma, mAtt, mDef, family: 'poisson', theta0: fit.theta });
    return { fit, family: 'poisson', r: Infinity, rRaw, rounds: rounds + 1 };
  }
  fit = fitTwoSided({ rows, nTeams, sigma, mAtt, mDef, family: 'negbin', r, theta0: fit.theta });
  return { fit, family: 'negbin', r, rRaw, rounds: rounds + 1 };
}
