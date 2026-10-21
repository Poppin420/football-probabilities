// Shared helpers used by the browser UI and by the pipeline (template text).
// Plain ES module, no dependencies.

/**
 * Round a set of probabilities that should sum to 1 to integer percentages
 * that sum to exactly `total` (largest-remainder / Hamilton method).
 */
export function largestRemainder(values, total = 100) {
  const sum = values.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return values.map(() => 0);
  const scaled = values.map((v) => (v / sum) * total);
  const floors = scaled.map((v) => Math.floor(v + 1e-9));
  const rest = total - floors.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < rest; k++) floors[order[k].i] += 1;
  return floors;
}

/** Plain integer percentage for a single probability. */
export function pct(p) {
  return Math.round(p * 100);
}

/** Greek decimal comma with a fixed number of decimals. */
export function num(x, digits = 1) {
  return Number(x).toFixed(digits).replace('.', ',');
}
