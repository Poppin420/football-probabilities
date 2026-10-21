// Poisson helpers, log-gamma and the Dixon-Coles score matrix.
// Pure functions, no I/O.

const LOG_FACT = [0];
for (let i = 1; i <= 170; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);

// Lanczos approximation (g = 7, n = 9), accurate to ~1e-14 for x > 0.
const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lgamma(x) {
  if (x < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS_C[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function logFactorial(n) {
  if (n < LOG_FACT.length) return LOG_FACT[n];
  return lgamma(n + 1);
}

/** Poisson pmf for k = 0..maxK (not renormalised). */
export function poissonPmfArray(lam, maxK) {
  const out = new Float64Array(maxK + 1);
  if (!(lam > 0)) {
    out[0] = 1;
    return out;
  }
  const logLam = Math.log(lam);
  for (let k = 0; k <= maxK; k++) {
    out[k] = Math.exp(-lam + k * logLam - logFactorial(k));
  }
  return out;
}

export function poissonPmf(k, lam) {
  if (!(lam > 0)) return k === 0 ? 1 : 0;
  return Math.exp(-lam + k * Math.log(lam) - logFactorial(k));
}

/** Dixon-Coles low-score correction factor. */
export function tau(i, j, lam, mu, rho) {
  if (i === 0 && j === 0) return 1 - lam * mu * rho;
  if (i === 0 && j === 1) return 1 + lam * rho;
  if (i === 1 && j === 0) return 1 + mu * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

export const MAX_GOALS = 14;

/**
 * Score matrix P(i, j) = tau * Pois(i; lam) * Pois(j; mu), i, j <= maxGoals,
 * renormalised to sum to exactly 1 (tau preserves total mass; the
 * renormalisation only removes the truncation error).
 * Returns { size, p } with p[i * size + j].
 */
export function scoreMatrix(lam, mu, rho = 0, maxGoals = MAX_GOALS) {
  const size = maxGoals + 1;
  const ph = poissonPmfArray(lam, maxGoals);
  const pa = poissonPmfArray(mu, maxGoals);
  const p = new Float64Array(size * size);
  let total = 0;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const t = Math.max(tau(i, j, lam, mu, rho), 0);
      const v = t * ph[i] * pa[j];
      p[i * size + j] = v;
      total += v;
    }
  }
  for (let k = 0; k < p.length; k++) p[k] /= total;
  return { size, p };
}

/** Element-wise mean of several score matrices (posterior predictive). */
export function meanMatrix(matrices) {
  const size = matrices[0].size;
  const p = new Float64Array(size * size);
  for (const m of matrices) for (let k = 0; k < p.length; k++) p[k] += m.p[k];
  for (let k = 0; k < p.length; k++) p[k] /= matrices.length;
  return { size, p };
}
