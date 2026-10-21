// Elo-only goals model for the Champions League (Phase 3).
//
// There is no common domestic history for the clubs of a European cup, so the
// expected goals come from the ClubElo rating difference alone:
//
//   lam = exp(c + eta + kappa * dE / 800)        (home)
//   mu  = exp(c       - kappa * dE / 800)        (away),     dE = E_home - E_away
//
// kappa (and eta, and a first c) come from ONE pooled weighted Poisson regression
// on the domestic matches of all leagues, each with the ClubElo rating of both
// teams from the monthly snapshot valid on the match day. The intercept of the
// cup is then "shrunk to the cup average": the maximum-likelihood intercept of the
// past cup matches (kappa and eta fixed), blended with the domestic intercept.
// rho is fitted exactly like stage 2 of the league model, on the pooled rows.
// Pure functions, no I/O.

import { newtonMaximize, choleskySolve } from './optimize.js';
import { rhoCell, rhoFromCells } from './dc.js';

export const ELO_DIV = 800;
/** A slope outside this range means that the Elo data or the name matching are broken, not that football changed. */
export const KAPPA_BOUNDS = Object.freeze([0.2, 2.0]);
export const MIN_ROWS = 1500; // pooled regression: matches with an Elo rating for both teams
export const SHRINK_MATCHES = 100; // n0: the cup intercept carries the weight of this many matches of the domestic one

/** Expected goals of a match. neutral = no home advantage (the final). */
export function eloOnlyMeans({ c, eta, kappa }, dE, { neutral = false } = {}) {
  const d = dE / ELO_DIV;
  return { lam: Math.exp(c + (neutral ? 0 : eta) + kappa * d), mu: Math.exp(c - kappa * d) };
}

/** Weighted Poisson log-likelihood (without the factorial constants) at th = [c, eta, kappa]. */
export function eloOnlyLogLik(rows, th) {
  let s = 0;
  for (const r of rows) {
    const a = th[0] + th[1] + th[2] * r.d;
    const b = th[0] - th[2] * r.d;
    s += r.w * (r.x * a - Math.exp(a) + r.y * b - Math.exp(b));
  }
  return s;
}

/**
 * Pooled weighted Poisson regression of home and away goals on the Elo difference.
 * @param {{x:number, y:number, d:number, w:number}[]} rows   d = dE / 800, w = time weight
 * @returns {{ok:boolean, c?:number, eta?:number, kappa?:number, se?:object, n:number, wSum?:number, iterations?:number, converged?:boolean, reason?:string}}
 */
export function fitEloOnly(rows, { minRows = MIN_ROWS, bounds = KAPPA_BOUNDS } = {}) {
  const n = rows.length;
  if (n < minRows) return { ok: false, n, reason: `only ${n} matches with an Elo rating for both teams (need ${minRows})` };
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const r of rows) {
    sw += r.w;
    sx += r.w * r.x;
    sy += r.w * r.y;
  }
  if (!(sx > 0 && sy > 0)) return { ok: false, n, reason: 'no goals in the sample' };

  const value = (th) => eloOnlyLogLik(rows, th);
  const derivs = (th) => {
    const g = new Float64Array(3);
    const H = new Float64Array(9);
    for (const r of rows) {
      const la = Math.exp(th[0] + th[1] + th[2] * r.d);
      const mu = Math.exp(th[0] - th[2] * r.d);
      const ra = r.x - la;
      const rb = r.y - mu;
      g[0] += r.w * (ra + rb);
      g[1] += r.w * ra;
      g[2] += r.w * r.d * (ra - rb);
      H[0] += r.w * (la + mu);
      H[1] += r.w * la;
      H[2] += r.w * r.d * (la - mu);
      H[4] += r.w * la;
      H[5] += r.w * r.d * la;
      H[8] += r.w * r.d * r.d * (la + mu);
    }
    H[3] = H[1];
    H[6] = H[2];
    H[7] = H[5];
    return { g, H };
  };

  const start = Float64Array.of(Math.log((sx + sy) / (2 * sw)) - 0.1, Math.log(sx / sy), 0.5);
  const fit = newtonMaximize({ value, derivs }, start, { maxIter: 100, tol: 1e-10 });
  const [c, eta, kappa] = fit.x;

  // Standard errors from the inverse Fisher information.
  const { H } = derivs(fit.x);
  const se = { c: NaN, eta: NaN, kappa: NaN };
  try {
    ['c', 'eta', 'kappa'].forEach((name, i) => {
      const e = new Float64Array(3);
      e[i] = 1;
      se[name] = Math.sqrt(choleskySolve(H, e, 3)[i]);
    });
  } catch {
    /* singular information: the standard errors stay NaN */
  }

  const out = { ok: true, c, eta, kappa, se, n, wSum: sw, iterations: fit.iterations, converged: fit.converged, logLik: fit.f };
  if (!fit.converged) return { ...out, ok: false, reason: 'the regression did not converge' };
  if (!(kappa >= bounds[0] && kappa <= bounds[1])) {
    return { ...out, ok: false, reason: `implausible Elo slope kappa = ${kappa.toFixed(3)} (expected ${bounds[0]}-${bounds[1]})` };
  }
  return out;
}

/**
 * Maximum-likelihood intercept of cup matches with kappa and eta fixed:
 *   c = log( sum w (x + y) / sum w ( e^{eta' + kappa d} + e^{-kappa d} ) ),   eta' = 0 on neutral ground.
 * rows: [{ x, y, d, w, neutral? }]. Returns null without usable goals.
 */
export function fitCupIntercept(rows, { eta, kappa }) {
  let goals = 0;
  let expo = 0;
  let wSum = 0;
  for (const r of rows) {
    goals += r.w * (r.x + r.y);
    expo += r.w * (Math.exp((r.neutral ? 0 : eta) + kappa * r.d) + Math.exp(-kappa * r.d));
    wSum += r.w;
  }
  if (!(goals > 0 && expo > 0)) return null;
  return { c: Math.log(goals / expo), n: rows.length, wSum };
}

/** Blend of the cup intercept and the domestic one; the cup weighs wSum / (wSum + n0). */
export function shrinkIntercept({ cCup, wSum, cBase, n0 = SHRINK_MATCHES }) {
  if (!Number.isFinite(cCup) || !(wSum > 0)) return { c: cBase, weight: 0 };
  const weight = wSum / (wSum + n0);
  return { c: weight * cCup + (1 - weight) * cBase, weight };
}

/** rho of the low-score correction on the pooled rows (stage 2 of the league model, with the Elo-only lam and mu). */
export function fitEloOnlyRho(rows, fit) {
  const cells = rows.map((r) => {
    const { lam, mu } = eloOnlyMeans(fit, r.d * ELO_DIV);
    return rhoCell(r.x, r.y, lam, mu, r.w);
  });
  return rhoFromCells(cells);
}
