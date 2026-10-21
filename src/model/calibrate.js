// Optional calibration layer (Phase 2): per-market recalibration of the model
// probabilities, kept ONLY if it improves nested out-of-sample log-loss.
//
//   1X2        p'_k  proportional to  delta_k * p_k^tau       (delta = (1, d, 1))
//              tau = temperature (>1 sharpens, <1 flattens), d = draw-inflation factor
//   Over 2.5   p'    = sigmoid(a + b * logit(p))               (per-market logistic recalibration)
//   BTTS       p'    = sigmoid(a + b * logit(p))
//
// The identity (tau = 1, d = 1, a = 0, b = 1) is the model without calibration.
// A calibrated matrix is obtained by iterative proportional fitting (raking):
// the 15 x 15 score matrix is rescaled until its 1X2, Over 2.5 and BTTS
// marginals equal the calibrated targets, so every other market (correct
// score, handicaps, scorers, ...) stays consistent with them.

import { fitLogistic, logLoss1x2, logLossBinary, pairedSe } from './metrics.js';
import { coreProbs } from './core.js';

export const MIN_NESTED_MATCHES = 400;
const EPS = 1e-9;
const clamp01 = (p) => Math.min(1 - EPS, Math.max(EPS, p));

/** cal = { x12: {tau, d}|null, ou25: {a, b}|null, btts: {a, b}|null }; null = identity. */
export function isIdentity(cal) {
  return !cal || (!cal.x12 && !cal.ou25 && !cal.btts);
}

export function calibrateX12(p, c) {
  if (!c) return p;
  const w = [Math.pow(clamp01(p[0]), c.tau), c.d * Math.pow(clamp01(p[1]), c.tau), Math.pow(clamp01(p[2]), c.tau)];
  const s = w[0] + w[1] + w[2];
  return [w[0] / s, w[1] / s, w[2] / s];
}

export function calibrateBinary(p, c) {
  if (!c) return p;
  const q = clamp01(p);
  return 1 / (1 + Math.exp(-(c.a + c.b * Math.log(q / (1 - q)))));
}

/** Calibrated { p: [pH, pD, pA], pOver, pBtts } from raw ones. */
export function calibrateCore(raw, cal) {
  return {
    p: calibrateX12(raw.p, cal?.x12),
    pOver: calibrateBinary(raw.pOver, cal?.ou25),
    pBtts: calibrateBinary(raw.pBtts, cal?.btts),
  };
}

// ---------------------------------------------------------------- raking --

/**
 * Rake a score matrix { size, p } so that its main-market marginals equal the
 * calibrated targets. Returns a NEW matrix summing to 1. With the identity
 * calibration the input is returned unchanged.
 */
export function calibrateMatrix(M, cal) {
  if (isIdentity(cal)) return M;
  const N = M.size;
  const raw = coreProbs(M);
  const t = calibrateCore({ p: [raw.pH, raw.pD, raw.pA], pOver: raw.pOver25, pBtts: raw.pBtts }, cal);

  // Cell groups of the three partitions.
  const groups = [];
  if (cal.x12) groups.push({ of: (i, j) => (i > j ? 0 : i === j ? 1 : 2), target: t.p });
  if (cal.ou25) groups.push({ of: (i, j) => (i + j >= 3 ? 0 : 1), target: [t.pOver, 1 - t.pOver] });
  if (cal.btts) groups.push({ of: (i, j) => (i > 0 && j > 0 ? 0 : 1), target: [t.pBtts, 1 - t.pBtts] });
  for (const g of groups) {
    g.idx = new Int8Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) g.idx[i * N + j] = g.of(i, j);
  }

  const p = Float64Array.from(M.p);
  for (let iter = 0; iter < 200; iter++) {
    let worst = 0;
    for (const g of groups) {
      const sums = new Float64Array(g.target.length);
      for (let k = 0; k < p.length; k++) sums[g.idx[k]] += p[k];
      const scale = sums.map((s, k) => (s > 1e-300 ? g.target[k] / s : 1));
      for (let k = 0; k < p.length; k++) p[k] *= scale[g.idx[k]];
    }
    // after a full sweep: how far is every marginal from its target?
    for (const g of groups) {
      const sums = new Float64Array(g.target.length);
      for (let k = 0; k < p.length; k++) sums[g.idx[k]] += p[k];
      for (let k = 0; k < sums.length; k++) worst = Math.max(worst, Math.abs(sums[k] - g.target[k]));
    }
    if (worst < 1e-12) break;
  }
  let total = 0;
  for (let k = 0; k < p.length; k++) total += p[k];
  for (let k = 0; k < p.length; k++) p[k] /= total;
  return { size: N, p };
}

/** Matrix transform for the bootstrap, or null for the identity. */
export function calibrationLayer(cal) {
  return isIdentity(cal) ? null : (M) => calibrateMatrix(M, cal);
}

// ---------------------------------------------------------------- fitting --

/**
 * Maximum-likelihood (tau, d) for the 1X2 recalibration, by damped Newton with a
 * small ridge towards the identity. records: [{ p: [pH, pD, pA], o }].
 */
export function fitX12(records, { ridge = 1, maxIter = 60 } = {}) {
  if (records.length < 100) return null;
  const lp = records.map((r) => r.p.map((v) => Math.log(clamp01(v))));
  let tau = 1;
  let gam = 0; // log d
  const nll = (t, g) => {
    let s = 0;
    for (let i = 0; i < records.length; i++) {
      const a = lp[i].map((v, k) => t * v + (k === 1 ? g : 0));
      const m = Math.max(...a);
      const z = m + Math.log(a.reduce((acc, v) => acc + Math.exp(v - m), 0));
      s += z - a[records[i].o];
    }
    return s + 0.5 * ridge * ((t - 1) ** 2 + g * g);
  };
  let f0 = nll(tau, gam);
  for (let iter = 0; iter < maxIter; iter++) {
    let gT = ridge * (tau - 1);
    let gG = ridge * gam;
    let hTT = ridge;
    let hTG = 0;
    let hGG = ridge;
    for (let i = 0; i < records.length; i++) {
      const a = lp[i].map((v, k) => tau * v + (k === 1 ? gam : 0));
      const m = Math.max(...a);
      const e = a.map((v) => Math.exp(v - m));
      const z = e[0] + e[1] + e[2];
      const q = e.map((v) => v / z);
      const o = records[i].o;
      const ml = q[0] * lp[i][0] + q[1] * lp[i][1] + q[2] * lp[i][2];
      gT += ml - lp[i][o]; // gradient of the NEGATIVE log-likelihood
      gG += q[1] - (o === 1 ? 1 : 0);
      const v2 = q[0] * lp[i][0] ** 2 + q[1] * lp[i][1] ** 2 + q[2] * lp[i][2] ** 2 - ml * ml;
      const cov = q[1] * lp[i][1] - q[1] * ml;
      hTT += v2;
      hTG += cov;
      hGG += q[1] * (1 - q[1]);
    }
    const det = hTT * hGG - hTG * hTG;
    if (!(det > 1e-12)) break;
    const dT = (gT * hGG - gG * hTG) / det;
    const dG = (gG * hTT - gT * hTG) / det;
    let step = 1;
    let moved = false;
    for (let ls = 0; ls < 30; ls++) {
      const t2 = tau - step * dT;
      const g2 = gam - step * dG;
      const f1 = nll(t2, g2);
      if (Number.isFinite(f1) && f1 <= f0 + 1e-12) {
        tau = t2;
        gam = g2;
        f0 = f1;
        moved = true;
        break;
      }
      step /= 2;
    }
    if (!moved || Math.abs(dT) + Math.abs(dG) < 1e-9) break;
  }
  tau = Math.min(3, Math.max(0.3, tau));
  gam = Math.min(1, Math.max(-1, gam));
  return { tau, d: Math.exp(gam) };
}

/** Logistic map for a binary market. preds / outcomes: parallel arrays. */
export function fitBinaryMap(preds, outcomes) {
  return fitLogistic(preds, outcomes, { ridge: 1 });
}

/** All three maps fitted on the same records (each may be null when there is too little data). */
export function fitCalibration(records) {
  return {
    x12: fitX12(records),
    ou25: fitBinaryMap(records.map((r) => r.pOver), records.map((r) => r.over)),
    btts: fitBinaryMap(records.map((r) => r.pBtts), records.map((r) => r.btts)),
  };
}

// ------------------------------------------------------ nested evaluation --

/** Log-loss (1X2, Over 2.5, BTTS) of one record under a calibration. */
export function recordLosses(rec, cal) {
  const c = calibrateCore(rec, cal);
  return {
    x12: logLoss1x2(c.p, rec.o),
    ou25: logLossBinary(c.pOver, rec.over),
    btts: logLossBinary(c.pBtts, rec.btts),
  };
}

/**
 * Forward-chaining evaluation. Records are sorted by time and cut into `blocks`
 * equal blocks; for every block b >= 1 the maps are fitted on the blocks before
 * it and scored on block b, so each score is strictly out-of-sample.
 * Returns, per market, the mean log-loss gain (positive = calibration helps),
 * its standard error (paired differences) and the decision.
 */
export function nestedEvaluate(records, { blocks = 5, minGain = 0.0005, seFactor = 1 } = {}) {
  const sorted = [...records].sort((a, b) => a.t - b.t);
  const n = sorted.length;
  const out = { n: 0, markets: {} };
  const markets = ['x12', 'ou25', 'btts'];
  const base = { x12: [], ou25: [], btts: [] };
  const cald = { x12: [], ou25: [], btts: [] };
  if (n < MIN_NESTED_MATCHES) {
    for (const m of markets) out.markets[m] = { gain: null, se: null, adopt: false, reason: `only ${n} matches` };
    return out;
  }
  for (let b = 1; b < blocks; b++) {
    const train = sorted.slice(0, Math.floor((n * b) / blocks));
    const test = sorted.slice(Math.floor((n * b) / blocks), Math.floor((n * (b + 1)) / blocks));
    const fit = fitCalibration(train);
    for (const rec of test) {
      const l0 = recordLosses(rec, null);
      const l1 = recordLosses(rec, fit);
      for (const m of markets) {
        base[m].push(l0[m]);
        cald[m].push(l1[m]);
      }
    }
  }
  out.n = base.x12.length;
  for (const m of markets) {
    const gain = base[m].reduce((s, v, i) => s + v - cald[m][i], 0) / base[m].length;
    const se = pairedSe(base[m], cald[m]);
    const adopt = gain >= minGain && gain >= seFactor * se;
    out.markets[m] = { gain, se, adopt, reason: adopt ? 'improves nested out-of-sample log-loss' : 'no clear out-of-sample gain' };
  }
  return out;
}

/** Keep only the maps whose market passed the nested evaluation. */
export function adoptedCalibration(fit, evaluation) {
  return {
    x12: evaluation.markets.x12.adopt ? fit.x12 : null,
    ou25: evaluation.markets.ou25.adopt ? fit.ou25 : null,
    btts: evaluation.markets.btts.adopt ? fit.btts : null,
  };
}
