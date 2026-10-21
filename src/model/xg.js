// Shots-based expected-goals proxy (Phase 2).
//
//   xGp = b1 * SoT + b2 * (Shots - SoT)           (b1, b2 >= 0, no intercept)
//
// (b1, b2) come from a league-level non-negative least squares of goals on
// [SoT, Shots - SoT], using every team-match side with complete shot data
// BEFORE the forecast date. The stage-1 goals model then fits the blended
// response
//
//   x* = om * x + (1 - om) * xGp         (om = 1 where shots are missing)
//
// om = 1 gives the Phase 1 model back. Pure functions, no I/O.

const MIN_SIDES = 200; // team-match sides needed before the proxy is trusted

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Shot inputs of one side of a match, or null when the data are missing / inconsistent. */
export function sideShots(shots, onTarget) {
  if (!isCount(shots) || !isCount(onTarget) || onTarget > shots) return null;
  return { sot: onTarget, off: shots - onTarget };
}

/**
 * Non-negative least squares for two regressors without intercept.
 * Returns { b1, b2 } with b1, b2 >= 0 (the exact optimum: the unconstrained
 * solution if it is feasible, otherwise the better of the two edge solutions).
 */
export function nnls2(suu, suv, svv, suy, svy, syy) {
  const sse = (b1, b2) => syy - 2 * b1 * suy - 2 * b2 * svy + b1 * b1 * suu + 2 * b1 * b2 * suv + b2 * b2 * svv;
  const det = suu * svv - suv * suv;
  if (det > 1e-12 * Math.max(1, suu * svv)) {
    const b1 = (suy * svv - svy * suv) / det;
    const b2 = (svy * suu - suy * suv) / det;
    if (b1 >= 0 && b2 >= 0) return { b1, b2 };
  }
  const cand = [{ b1: 0, b2: 0 }];
  if (suu > 0) cand.push({ b1: Math.max(0, suy / suu), b2: 0 });
  if (svv > 0) cand.push({ b1: 0, b2: Math.max(0, svy / svv) });
  cand.sort((p, q) => sse(p.b1, p.b2) - sse(q.b1, q.b2));
  return cand[0];
}

/**
 * League-level proxy coefficients from the matches before tNow.
 * matches: [{ t, x, y, hs, as, hst, ast }]
 * Returns { b1, b2, n, bias } or null when there are too few usable sides.
 * bias = sum(xGp) / sum(goals) over the fitting sample (1 = unbiased level).
 * rescale = true multiplies (b1, b2) by 1 / bias so that the proxy has exactly the
 * level of the goals (an option for testing; the spec uses the plain NNLS fit).
 */
export function fitXgProxy(matches, tNow, { minSides = MIN_SIDES, rescale = false } = {}) {
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suy = 0;
  let svy = 0;
  let syy = 0;
  let n = 0;
  let goals = 0;
  let sumSot = 0;
  let sumOff = 0;
  const add = (s, g) => {
    if (!s) return;
    suu += s.sot * s.sot;
    suv += s.sot * s.off;
    svv += s.off * s.off;
    suy += s.sot * g;
    svy += s.off * g;
    syy += g * g;
    goals += g;
    sumSot += s.sot;
    sumOff += s.off;
    n++;
  };
  for (const m of matches) {
    if (!(m.t < tNow)) continue; // strictly before: no leakage
    add(sideShots(m.hs, m.hst), m.x);
    add(sideShots(m.as, m.ast), m.y);
  }
  if (n < minSides || !(goals > 0)) return null;
  const { b1, b2 } = nnls2(suu, suv, svv, suy, svy, syy);
  if (!(b1 > 0 || b2 > 0)) return null;
  const bias = (b1 * sumSot + b2 * sumOff) / goals;
  // rescale (off by default, not part of the spec): make the proxy sum to the goals of the sample.
  const k = rescale && bias > 0 ? 1 / bias : 1;
  return { b1: b1 * k, b2: b2 * k, n, bias: bias * k, rawBias: bias };
}

/** Proxy for one side, or null when its shots are missing. */
export function xgOfSide(proxy, shots, onTarget) {
  const s = sideShots(shots, onTarget);
  return s ? proxy.b1 * s.sot + proxy.b2 * s.off : null;
}

/**
 * Copy of the matches with the stage-1 responses xr / yr set to
 * om * goals + (1 - om) * xGp (goals alone where shots are missing).
 * om >= 1 or no proxy: the matches are returned unchanged (Phase 1).
 */
export function withBlendedResponses(matches, proxy, om) {
  if (!proxy || !(om < 1)) return matches;
  const w = Math.max(0, om);
  return matches.map((m) => {
    const xg = xgOfSide(proxy, m.hs, m.hst);
    const yg = xgOfSide(proxy, m.as, m.ast);
    if (xg === null && yg === null) return m;
    return {
      ...m,
      xr: xg === null ? m.x : w * m.x + (1 - w) * xg,
      yr: yg === null ? m.y : w * m.y + (1 - w) * yg,
    };
  });
}
