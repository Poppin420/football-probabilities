// Dixon-Coles type goals model, two stages, one parameter set per league.
//
// Stage 1: weighted Poisson quasi-likelihood with a Gaussian prior on the
//          team attack / defence parameters (see glm.js for the engine).
// Stage 2: low-score dependence parameter rho by golden-section search on
//          the weighted tau log-likelihood, using integer goals and the
//          stage-1 lambda / mu.

import { fitTwoSided } from './glm.js';
import { goldenSection } from './optimize.js';
import { scoreMatrix } from './poisson.js';

export const DEFAULTS = Object.freeze({
  xi: 0.0019, // time decay per day (half-life about one year)
  sigma: 0.25, // prior sd of attack / defence
  promotedAtt: -0.25,
  promotedDef: 0.2,
  rhoLo: -0.25,
  rhoHi: 0.1,
});

/** w_k = exp(-xi * (tNow - t_k)); t in days. */
export function timeWeight(t, tNow, xi) {
  return Math.exp(-xi * (tNow - t));
}

/**
 * Prior means for attack / defence. Phase 1: zero, except promoted teams
 * (att = -0.25, def = +0.20). The means are then centred to mean 0 so that
 * the league intercept keeps its meaning.
 */
export function buildPriorMeans(teams, promoted = new Set(), opts = {}) {
  const pa = opts.promotedAtt ?? DEFAULTS.promotedAtt;
  const pd = opts.promotedDef ?? DEFAULTS.promotedDef;
  const n = teams.length;
  const mAtt = new Float64Array(n);
  const mDef = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (promoted.has(teams[i])) {
      mAtt[i] = pa;
      mDef[i] = pd;
    }
  }
  return centre({ mAtt, mDef });
}

export function centre({ mAtt, mDef }) {
  const n = mAtt.length;
  if (n === 0) return { mAtt, mDef };
  let sa = 0;
  let sd = 0;
  for (let i = 0; i < n; i++) {
    sa += mAtt[i];
    sd += mDef[i];
  }
  sa /= n;
  sd /= n;
  for (let i = 0; i < n; i++) {
    mAtt[i] -= sa;
    mDef[i] -= sd;
  }
  return { mAtt, mDef };
}

/**
 * Fit stage 1.
 *
 * matches: [{ t, home, away, x, y, xr?, yr? }]  (team keys are strings,
 *          x/y actual goals, xr/yr optional stage-1 responses)
 * Only matches with t < tNow (strictly before) are used.
 */
export function fitGoals({
  matches,
  teams,
  tNow,
  xi = DEFAULTS.xi,
  sigma = DEFAULTS.sigma,
  promoted = new Set(),
  priorMeans = null,
  tol = 1e-8,
  theta0 = null,
}) {
  const index = new Map();
  teams.forEach((k, i) => index.set(k, i));
  const used = [];
  const rows = [];
  for (const m of matches) {
    if (!(m.t < tNow)) continue; // strictly before: no leakage
    const h = index.get(m.home);
    const a = index.get(m.away);
    if (h === undefined || a === undefined) {
      throw new Error(`Unknown team in match: ${m.home} vs ${m.away}`);
    }
    used.push(m);
    rows.push({
      h,
      a,
      x: m.xr ?? m.x,
      y: m.yr ?? m.y,
      w: timeWeight(m.t, tNow, xi),
    });
  }
  if (rows.length === 0) throw new Error('No training matches before tNow');

  const n = teams.length;
  const pm = priorMeans ? centre({ mAtt: Float64Array.from(priorMeans.mAtt), mDef: Float64Array.from(priorMeans.mDef) })
    : buildPriorMeans(teams, promoted);
  const fit = fitTwoSided({ rows, nTeams: n, sigma, mAtt: pm.mAtt, mDef: pm.mDef, tol, theta0 });

  // Effective data per team and weighted goals per match (actual goals).
  const effN = new Float64Array(n);
  const gfSum = new Float64Array(n);
  const gaSum = new Float64Array(n);
  for (let k = 0; k < used.length; k++) {
    const r = rows[k];
    const m = used[k];
    effN[r.h] += r.w;
    effN[r.a] += r.w;
    gfSum[r.h] += r.w * m.x;
    gaSum[r.h] += r.w * m.y;
    gfSum[r.a] += r.w * m.y;
    gaSum[r.a] += r.w * m.x;
  }
  const gfBar = new Float64Array(n);
  const gaBar = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    gfBar[i] = effN[i] > 0 ? gfSum[i] / effN[i] : NaN;
    gaBar[i] = effN[i] > 0 ? gaSum[i] / effN[i] : NaN;
  }

  return {
    teams: teams.slice(),
    index,
    c: fit.c,
    eta: fit.eta,
    att: fit.att,
    def: fit.def,
    theta: fit.theta,
    f: fit.f,
    trace: fit.trace,
    iterations: fit.iterations,
    converged: fit.converged,
    xi,
    sigma,
    tNow,
    nUsed: used.length,
    wSum: rows.reduce((s, r) => s + r.w, 0),
    effN,
    gfBar,
    gaBar,
    priorMeans: pm,
    rows,
    used,
  };
}

/** lambda (home) and mu (away) for a pairing. etaOverride lets tests set eta = 0. */
export function predictLambdaMu(model, home, away, etaOverride = undefined) {
  const h = model.index.get(home);
  const a = model.index.get(away);
  if (h === undefined || a === undefined) throw new Error(`Unknown team: ${home} / ${away}`);
  const eta = etaOverride === undefined ? model.eta : etaOverride;
  return {
    lam: Math.exp(model.c + eta + model.att[h] + model.def[a]),
    mu: Math.exp(model.c + model.att[a] + model.def[h]),
  };
}

/**
 * Stage 2: rho = argmax sum_k w_k log tau(x_k, y_k; lam_k, mu_k, rho)
 * over [-0.25, 0.10]. Every tau is affine in rho, so the log-likelihood is
 * concave on the feasible interval where all tau > 0; that interval is
 * computed explicitly and golden-section search runs inside it.
 */
export function fitRho(model, { lo = DEFAULTS.rhoLo, hi = DEFAULTS.rhoHi } = {}) {
  const cells = [];
  for (let k = 0; k < model.used.length; k++) {
    const m = model.used[k];
    if (m.x > 1 || m.y > 1) continue; // tau = 1 elsewhere
    const r = model.rows[k];
    const lam = Math.exp(model.c + model.eta + model.att[r.h] + model.def[r.a]);
    const mu = Math.exp(model.c + model.att[r.a] + model.def[r.h]);
    cells.push(rhoCell(m.x, m.y, lam, mu, r.w));
  }
  return rhoFromCells(cells, { lo, hi });
}

/**
 * One match as a cell of the rho likelihood: tau = 1 + s * rho for the four low
 * scores. Returns null for every other score (tau = 1 there).
 */
export function rhoCell(x, y, lam, mu, w) {
  if (x > 1 || y > 1) return null;
  let s;
  if (x === 0 && y === 0) s = -lam * mu;
  else if (x === 0 && y === 1) s = lam;
  else if (x === 1 && y === 0) s = mu;
  else s = -1;
  return { s, w };
}

/**
 * The argmax of sum_k w_k log(1 + s_k rho) over the feasible part of [lo, hi],
 * where every tau stays positive (the function is concave there). Shared by the
 * league model (fitRho) and the Elo-only model of the Champions League.
 */
export function rhoFromCells(allCells, { lo = DEFAULTS.rhoLo, hi = DEFAULTS.rhoHi } = {}) {
  const cells = allCells.filter(Boolean);
  let a = lo;
  let b = hi;
  const eps = 1e-6;
  for (const c of cells) {
    if (c.s > 0) a = Math.max(a, -1 / c.s + eps);
    else if (c.s < 0) b = Math.min(b, -1 / c.s - eps);
  }
  if (!(a < b)) return { rho: 0, lo: a, hi: b, feasible: false };
  const ll = (rho) => {
    let s = 0;
    for (const c of cells) s += c.w * Math.log(1 + c.s * rho);
    return s;
  };
  const { x } = goldenSection(ll, a, b, 1e-8);
  return { rho: x, lo: a, hi: b, feasible: true };
}

/** Score matrix for one fixture from a fitted model and rho. */
export function forecastMatch(model, rho, home, away, etaOverride = undefined) {
  const { lam, mu } = predictLambdaMu(model, home, away, etaOverride);
  return { lam, mu, rho, matrix: scoreMatrix(lam, mu, rho) };
}
