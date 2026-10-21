// Small numerical toolbox: dense Cholesky solve, damped Newton ascent,
// golden-section search. Pure functions, no dependencies.

/**
 * Solve A x = b for a symmetric positive definite A (flat row-major n x n).
 * Throws if A is not positive definite.
 */
export function choleskySolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(sum > 0)) throw new Error('Matrix is not positive definite');
        L[i * n + i] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  // Forward substitution L y = b
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  // Back substitution L^T x = y
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

/**
 * Damped Newton / Fisher-scoring ascent with Armijo backtracking.
 *
 * problem.value(x)  -> f(x)                       (to be maximised)
 * problem.derivs(x) -> { f, g, H }                g = gradient of f,
 *                      H = POSITIVE definite information matrix (flat n x n),
 *                      i.e. minus the (expected) Hessian.
 *
 * Because every accepted step satisfies the Armijo condition, the trace of
 * f is non-decreasing. Convergence: Newton decrement g'H^-1 g / 2 < tol.
 */
export function newtonMaximize(problem, x0, { maxIter = 100, tol = 1e-8 } = {}) {
  const n = x0.length;
  let x = Float64Array.from(x0);
  let f = problem.value(x);
  if (!Number.isFinite(f)) throw new Error('Objective is not finite at the starting point');
  const trace = [f];
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    const { g, H } = problem.derivs(x);
    const step = choleskySolve(H, g, n);
    let slope = 0;
    for (let i = 0; i < n; i++) slope += g[i] * step[i];
    if (!(slope >= 0)) throw new Error('Newton direction is not an ascent direction');
    if (slope / 2 < tol) {
      converged = true;
      break;
    }
    let t = 1;
    let accepted = false;
    for (let ls = 0; ls < 50; ls++) {
      const cand = new Float64Array(n);
      for (let i = 0; i < n; i++) cand[i] = x[i] + t * step[i];
      const fc = problem.value(cand);
      if (Number.isFinite(fc) && fc >= f + 1e-4 * t * slope) {
        x = cand;
        f = fc;
        accepted = true;
        break;
      }
      t /= 2;
    }
    iterations = iter + 1;
    if (!accepted) {
      // No improving step: we are at numerical precision.
      converged = slope / 2 < 1e-6;
      break;
    }
    trace.push(f);
  }
  return { x, f, trace, iterations, converged };
}

/**
 * Golden-section search for the MAXIMUM of a unimodal function on [lo, hi].
 * Returns { x, fx }.
 */
export function goldenSection(fn, lo, hi, tol = 1e-7, maxIter = 200) {
  const invPhi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - invPhi * (b - a);
  let d = a + invPhi * (b - a);
  let fc = fn(c);
  let fd = fn(d);
  for (let i = 0; i < maxIter && Math.abs(b - a) > tol; i++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - invPhi * (b - a);
      fc = fn(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + invPhi * (b - a);
      fd = fn(d);
    }
  }
  const x = (a + b) / 2;
  return { x, fx: fn(x) };
}

/** Central finite-difference gradient (used by tests). */
export function numericGradient(fn, x, h = 1e-6) {
  const g = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xp = Float64Array.from(x);
    const xm = Float64Array.from(x);
    xp[i] += h;
    xm[i] -= h;
    g[i] = (fn(xp) - fn(xm)) / (2 * h);
  }
  return g;
}
