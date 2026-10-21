// Two-sided count model engine shared by goals (Poisson quasi-likelihood),
// corners and yellow cards (negative binomial).
//
//   log m_home = c + eta + att_h + def_a
//   log m_away = c       + att_a + def_h
//
// def = defensive WEAKNESS (higher = concedes more). c and eta are
// unpenalised; att and def have a Gaussian prior N(m_i, sigma^2).
//
// Parameter vector: theta = [c, eta, att_0..att_{n-1}, def_0..def_{n-1}].

import { newtonMaximize } from './optimize.js';
import { lgamma } from './poisson.js';

/**
 * Observations: { h, a, x, y, w } as parallel typed arrays
 * (team indices, responses, weights).
 * family: 'poisson' | 'negbin' (with size r).
 */
export function makeObjective({ h, a, x, y, w, nTeams, sigma, mAtt, mDef, family = 'poisson', r = Infinity }) {
  const n = nTeams;
  const dim = 2 + 2 * n;
  const K = h.length;
  const invS2 = 1 / (sigma * sigma);
  const negbin = family === 'negbin';

  function prior(theta) {
    let q = 0;
    for (let i = 0; i < n; i++) {
      const da = theta[2 + i] - mAtt[i];
      const dd = theta[2 + n + i] - mDef[i];
      q += da * da + dd * dd;
    }
    return -0.5 * q * invS2;
  }

  // Per-observation log-likelihood kernel (constants in the data dropped).
  function kernel(resp, eta) {
    const m = Math.exp(eta);
    if (!negbin) return resp * eta - m;
    return -r * Math.log1p(m / r) + resp * (eta - Math.log(r + m));
  }

  function value(theta) {
    const c = theta[0];
    const eta = theta[1];
    let f = prior(theta);
    for (let k = 0; k < K; k++) {
      const e1 = c + eta + theta[2 + h[k]] + theta[2 + n + a[k]];
      const e2 = c + theta[2 + a[k]] + theta[2 + n + h[k]];
      f += w[k] * (kernel(x[k], e1) + kernel(y[k], e2));
    }
    return f;
  }

  function derivs(theta) {
    const c = theta[0];
    const eta = theta[1];
    const g = new Float64Array(dim);
    const H = new Float64Array(dim * dim);
    let f = prior(theta);

    const idx1 = [0, 1, 0, 0];
    const idx2 = [0, 0, 0];

    for (let k = 0; k < K; k++) {
      const i1 = 2 + h[k];
      const j1 = 2 + n + a[k];
      const i2 = 2 + a[k];
      const j2 = 2 + n + h[k];
      const e1 = c + eta + theta[i1] + theta[j1];
      const e2 = c + theta[i2] + theta[j2];
      const m1 = Math.exp(e1);
      const m2 = Math.exp(e2);
      f += w[k] * (kernel(x[k], e1) + kernel(y[k], e2));

      let s1;
      let s2;
      let wt1;
      let wt2;
      if (negbin) {
        const d1 = 1 + m1 / r;
        const d2 = 1 + m2 / r;
        s1 = (x[k] - m1) / d1;
        s2 = (y[k] - m2) / d2;
        wt1 = m1 / d1; // Fisher information weight m / (1 + m / r)
        wt2 = m2 / d2;
      } else {
        s1 = x[k] - m1;
        s2 = y[k] - m2;
        wt1 = m1;
        wt2 = m2;
      }
      s1 *= w[k];
      s2 *= w[k];
      wt1 *= w[k];
      wt2 *= w[k];

      idx1[2] = i1;
      idx1[3] = j1;
      idx2[1] = i2;
      idx2[2] = j2;
      for (let p = 0; p < 4; p++) {
        g[idx1[p]] += s1;
        for (let q = 0; q < 4; q++) H[idx1[p] * dim + idx1[q]] += wt1;
      }
      for (let p = 0; p < 3; p++) {
        g[idx2[p]] += s2;
        for (let q = 0; q < 3; q++) H[idx2[p] * dim + idx2[q]] += wt2;
      }
    }
    for (let i = 0; i < n; i++) {
      g[2 + i] -= (theta[2 + i] - mAtt[i]) * invS2;
      g[2 + n + i] -= (theta[2 + n + i] - mDef[i]) * invS2;
      H[(2 + i) * dim + (2 + i)] += invS2;
      H[(2 + n + i) * dim + (2 + n + i)] += invS2;
    }
    return { f, g, H };
  }

  return { dim, value, derivs };
}

/** Pack observation rows into typed arrays. rows: [{h, a, x, y, w}] */
export function packObs(rows) {
  const K = rows.length;
  const h = new Int32Array(K);
  const a = new Int32Array(K);
  const x = new Float64Array(K);
  const y = new Float64Array(K);
  const w = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    h[k] = rows[k].h;
    a[k] = rows[k].a;
    x[k] = rows[k].x;
    y[k] = rows[k].y;
    w[k] = rows[k].w;
  }
  return { h, a, x, y, w };
}

/**
 * Maximise the penalised likelihood. Returns the fitted parameters,
 * the trace of the objective (non-decreasing) and convergence info.
 */
export function fitTwoSided({
  rows,
  nTeams,
  sigma,
  mAtt = null,
  mDef = null,
  family = 'poisson',
  r = Infinity,
  theta0 = null,
  tol = 1e-8,
  maxIter = 100,
}) {
  const obs = packObs(rows);
  const mA = mAtt || new Float64Array(nTeams);
  const mD = mDef || new Float64Array(nTeams);
  const objective = makeObjective({ ...obs, nTeams, sigma, mAtt: mA, mDef: mD, family, r });

  let start = theta0;
  if (!start) {
    start = new Float64Array(objective.dim);
    let sw = 0;
    let sg = 0;
    for (let k = 0; k < rows.length; k++) {
      sw += 2 * rows[k].w;
      sg += rows[k].w * (rows[k].x + rows[k].y);
    }
    start[0] = Math.log(Math.max(sg / Math.max(sw, 1e-9), 0.05));
    for (let i = 0; i < nTeams; i++) {
      start[2 + i] = mA[i];
      start[2 + nTeams + i] = mD[i];
    }
  }
  const res = newtonMaximize(objective, start, { tol, maxIter });
  const theta = res.x;
  return {
    theta,
    c: theta[0],
    eta: theta[1],
    att: theta.slice(2, 2 + nTeams),
    def: theta.slice(2 + nTeams, 2 + 2 * nTeams),
    f: res.f,
    trace: res.trace,
    iterations: res.iterations,
    converged: res.converged,
    family,
    r,
  };
}

/** Fitted means for every observation row. */
export function fittedMeans(fit, rows) {
  const n = fit.att.length;
  const m1 = new Float64Array(rows.length);
  const m2 = new Float64Array(rows.length);
  for (let k = 0; k < rows.length; k++) {
    const { h, a } = rows[k];
    m1[k] = Math.exp(fit.c + fit.eta + fit.att[h] + fit.def[a]);
    m2[k] = Math.exp(fit.c + fit.att[a] + fit.def[h]);
  }
  return { m1, m2, n };
}

/** Full negative binomial log-likelihood term (with lgamma constants). */
export function nbLogPmf(k, m, r) {
  return (
    lgamma(k + r) - lgamma(r) - lgamma(k + 1) +
    r * Math.log(r / (r + m)) +
    k * Math.log(m / (r + m))
  );
}
