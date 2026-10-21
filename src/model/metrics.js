// Forecast scores for the back-test and the reliability report.
// All functions are pure. Probabilities are clipped away from 0 and 1 before
// taking logarithms so one extreme miss cannot produce an infinite loss.

const EPS = 1e-6;
const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));

/** Ranked probability score of a 1X2 forecast p = [pH, pD, pA] (outcome index o: 0 / 1 / 2). */
export function rps(p, o) {
  const oH = o === 0 ? 1 : 0;
  const oD = o === 1 ? 1 : 0;
  return 0.5 * ((p[0] - oH) ** 2 + (p[0] + p[1] - oH - oD) ** 2);
}

export function logLoss1x2(p, o) {
  return -Math.log(clip(p[o]));
}

/** Multi-class Brier score (sum over the three outcomes). */
export function brier1x2(p, o) {
  let s = 0;
  for (let k = 0; k < 3; k++) s += (p[k] - (k === o ? 1 : 0)) ** 2;
  return s;
}

export function logLossBinary(p, y) {
  return -Math.log(clip(y ? p : 1 - p));
}

export function brierBinary(p, y) {
  return (p - y) ** 2;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/** Standard error of the mean of paired differences d_k = a_k - b_k. */
export function pairedSe(a, b) {
  const n = a.length;
  if (n < 2) return NaN;
  const d = a.map((v, i) => v - b[i]);
  const m = mean(d);
  let ss = 0;
  for (const v of d) ss += (v - m) ** 2;
  return Math.sqrt(ss / (n - 1) / n);
}

/**
 * Scores of one set of forecast records.
 * record: { p: [pH, pD, pA], o, pOver, over, pBtts, btts }
 * Returns means per market and the tuning objective (sum of the three
 * log-losses: 1X2 + Over/Under 2.5 + BTTS).
 */
export function summarize(records, pick = (r) => r) {
  const x12 = { rps: [], logLoss: [], brier: [] };
  const ou = { logLoss: [], brier: [] };
  const bt = { logLoss: [], brier: [] };
  for (const rec of records) {
    const r = pick(rec);
    x12.rps.push(rps(r.p, rec.o));
    x12.logLoss.push(logLoss1x2(r.p, rec.o));
    x12.brier.push(brier1x2(r.p, rec.o));
    ou.logLoss.push(logLossBinary(r.pOver, rec.over));
    ou.brier.push(brierBinary(r.pOver, rec.over));
    bt.logLoss.push(logLossBinary(r.pBtts, rec.btts));
    bt.brier.push(brierBinary(r.pBtts, rec.btts));
  }
  return {
    n: records.length,
    x12: { rps: mean(x12.rps), logLoss: mean(x12.logLoss), brier: mean(x12.brier) },
    ou25: { logLoss: mean(ou.logLoss), brier: mean(ou.brier) },
    btts: { logLoss: mean(bt.logLoss), brier: mean(bt.brier) },
    objective: mean(x12.logLoss) + mean(ou.logLoss) + mean(bt.logLoss),
  };
}

/** Per-match tuning objective (1X2 + O/U 2.5 + BTTS log-loss) of every record. */
export function objectiveSeries(records, pick = (r) => r) {
  return records.map((rec) => {
    const r = pick(rec);
    return logLoss1x2(r.p, rec.o) + logLossBinary(r.pOver, rec.over) + logLossBinary(r.pBtts, rec.btts);
  });
}

/** Equal-width reliability bins: mean forecast vs observed frequency. Empty bins are dropped. */
export function calibrationBins(preds, outcomes, nBins = 10) {
  const bins = Array.from({ length: nBins }, (_, b) => ({ lo: b / nBins, hi: (b + 1) / nBins, n: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const b = Math.min(nBins - 1, Math.floor(preds[i] * nBins));
    bins[b].n++;
    bins[b].sumP += preds[i];
    bins[b].sumY += outcomes[i];
  }
  return bins.filter((b) => b.n > 0).map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, p: b.sumP / b.n, f: b.sumY / b.n }));
}

/**
 * Logistic recalibration of outcomes y on logit(p): P(y = 1) = sigmoid(a + b * logit(p)).
 * b = 1 and a = 0 mean perfectly calibrated; the slope is the usual
 * "calibration slope". A tiny ridge towards (0, 1) keeps the fit finite.
 * Returns { a, b } or null when there is too little data.
 */
export function fitLogistic(preds, outcomes, { ridge = 1e-3, maxIter = 50 } = {}) {
  const n = preds.length;
  if (n < 30) return null;
  const z = preds.map((p) => Math.log(clip(p) / (1 - clip(p))));
  let a = 0;
  let b = 1;
  for (let iter = 0; iter < maxIter; iter++) {
    let ga = -ridge * a;
    let gb = -ridge * (b - 1);
    let haa = ridge;
    let hab = 0;
    let hbb = ridge;
    for (let i = 0; i < n; i++) {
      const eta = a + b * z[i];
      const m = 1 / (1 + Math.exp(-eta));
      const w = m * (1 - m);
      const r = outcomes[i] - m;
      ga += r;
      gb += r * z[i];
      haa += w;
      hab += w * z[i];
      hbb += w * z[i] * z[i];
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 1e-12)) return null;
    const da = (ga * hbb - gb * hab) / det;
    const db = (gb * haa - ga * hab) / det;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null;
}

/** Reliability summary of one binary forecast series: bins + calibration slope / intercept. */
export function calibrationOf(preds, outcomes, nBins = 10) {
  const fit = fitLogistic(preds, outcomes);
  return { bins: calibrationBins(preds, outcomes, nBins), slope: fit ? fit.b : null, intercept: fit ? fit.a : null };
}

/** Calibration of every market of a set of records. */
export function calibrationReport(records, pick = (r) => r) {
  const col = (f) => records.map((rec) => f(pick(rec), rec));
  return {
    home: calibrationOf(col((r) => r.p[0]), col((_r, rec) => (rec.o === 0 ? 1 : 0))),
    draw: calibrationOf(col((r) => r.p[1]), col((_r, rec) => (rec.o === 1 ? 1 : 0))),
    away: calibrationOf(col((r) => r.p[2]), col((_r, rec) => (rec.o === 2 ? 1 : 0))),
    ou25: calibrationOf(col((r) => r.pOver), col((_r, rec) => rec.over)),
    btts: calibrationOf(col((r) => r.pBtts), col((_r, rec) => rec.btts)),
  };
}

// ---------------------------------------------------------------------------
// Half-time markets (Phase 3). Records carry `hf` (see backtest.js): the
// forecasts of the half-time result, of the nine HT/FT combinations and of the
// first-half goal lines, the outcome, and the base rates of the training sample.

const logLossAt = (p, idx) => -Math.log(clip(p[idx]));

/** Scores of the half-time markets against their base rates. Records without `hf` are ignored. */
export function summarizeHalf(records) {
  const recs = records.filter((r) => r.hf);
  const m = (f) => mean(recs.map(f));
  const out = (pick) => ({
    ht: { rps: m((r) => rps(pick(r).ht, r.hf.oHt)), logLoss: m((r) => logLossAt(pick(r).ht, r.hf.oHt)) },
    htft: { logLoss: m((r) => logLossAt(pick(r).joint, r.hf.oJoint)) },
    over05: { logLoss: m((r) => logLossBinary(pick(r).over05, r.hf.y05)) },
    over15: { logLoss: m((r) => logLossBinary(pick(r).over15, r.hf.y15)) },
  });
  return { n: recs.length, model: out((r) => r.hf), base: out((r) => r.hf.base) };
}

/** 1 - model / reference for every half-time score (positive = better than the base rates). */
export function halfSkill(s) {
  const sk = (a, b) => (b > 0 ? 1 - a / b : null);
  return {
    htRps: sk(s.model.ht.rps, s.base.ht.rps),
    htLogLoss: sk(s.model.ht.logLoss, s.base.ht.logLoss),
    htft: sk(s.model.htft.logLoss, s.base.htft.logLoss),
    over05: sk(s.model.over05.logLoss, s.base.over05.logLoss),
    over15: sk(s.model.over15.logLoss, s.base.over15.logLoss),
  };
}
