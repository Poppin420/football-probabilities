// Half-time / full-time markets (Phase 3).
//
// The full-time score matrix P(X, Y) is the same Dixon-Coles matrix that gives
// the displayed 1X2, so the half-time markets are derived FROM it by exact
// binomial thinning, the same device as the scorer probabilities (scorers.js):
// every goal of a team is scored in the first half with probability s, and the
// goals are independent of each other given the full-time score:
//
//   H1 | X ~ Binomial(X, s),   A1 | Y ~ Binomial(Y, s)
//
// Consequences (all unit-tested):
//  - the nine HT/FT probabilities sum to 1 and, summed over the half-time
//    result, reproduce the full-time 1X2 of the matrix exactly;
//  - for an independent-Poisson matrix the two halves are independent Poisson
//    variables with means s*lam and (1-s)*lam (and likewise for mu).
//
// s is the weighted share of all goals that league history scored in the first
// half (about 0.45 everywhere), estimated with the same time weights as the
// goals model. Pure functions, no I/O.

import { timeWeight } from './dc.js';

/** Order of the nine combinations: half-time result first, full-time result second. 1 = home, X = draw, 2 = away. */
export const HTFT_KEYS = Object.freeze(['11', '1X', '12', 'X1', 'XX', 'X2', '21', '2X', '22']);
export const FIRST_HALF_LINES = Object.freeze([0.5, 1.5, 2.5]);

export const SHARE_BOUNDS = Object.freeze([0.3, 0.6]); // outside: the data are broken, not the football
export const MIN_SHARE_MATCHES = 200; // matches with a half-time score needed for the estimate

/**
 * First-half share of the goals: sum w (HT home + HT away goals) / sum w (FT home + FT away goals).
 * history rows: { t, x, y, hthg, htag }. Rows without a half-time score, or with an impossible one
 * (more half-time than full-time goals), are ignored; so is everything on or after tNow.
 * @returns {{ok:boolean, s?:number, n:number, goals?:number, reason?:string}}
 */
export function estimateHalfShare(history, tNow, xi, { minMatches = MIN_SHARE_MATCHES } = {}) {
  let num = 0;
  let den = 0;
  let n = 0;
  let goals = 0;
  for (const m of history) {
    if (!(m.t < tNow)) continue;
    const { hthg, htag, x, y } = m;
    if (!Number.isInteger(hthg) || !Number.isInteger(htag) || !Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (hthg < 0 || htag < 0 || hthg > x || htag > y) continue;
    const w = timeWeight(m.t, tNow, xi);
    num += w * (hthg + htag);
    den += w * (x + y);
    n++;
    goals += x + y;
  }
  if (n < minMatches) return { ok: false, n, reason: `only ${n} matches with a half-time score (need ${minMatches})` };
  if (!(den > 0)) return { ok: false, n, reason: 'no goals in the matches with a half-time score' };
  const s = num / den;
  if (!(s >= SHARE_BOUNDS[0] && s <= SHARE_BOUNDS[1])) {
    return { ok: false, n, reason: `implausible first-half share ${s.toFixed(3)}` };
  }
  return { ok: true, s, n, goals };
}

// Binomial pmf table for n = 0..maxN (exact binomial coefficients up to C(14, 7) = 3432 are small integers).
function binomialTable(maxN, s) {
  const table = [];
  for (let n = 0; n <= maxN; n++) {
    const row = new Float64Array(n + 1);
    let c = 1; // C(n, k)
    for (let k = 0; k <= n; k++) {
      row[k] = c * Math.pow(s, k) * Math.pow(1 - s, n - k);
      c = (c * (n - k)) / (k + 1);
    }
    table.push(row);
  }
  return table;
}

const outcome = (a, b) => (a > b ? 0 : a === b ? 1 : 2); // 0 home, 1 draw, 2 away

/**
 * Half-time markets of one fixture.
 * @param {{size:number, p:Float64Array}} M   full-time score matrix, p[x * size + y]
 * @param {number} s                           first-half share of goals
 * @returns {{ s:number, ht:{home:number,draw:number,away:number}, htft:number[], firstHalf:{mean:number, totals:{line:number,over:number,under:number}[]} }}
 *          htft follows HTFT_KEYS.
 */
export function halfTimeMarkets(M, s) {
  const N = M.size;
  const bin = binomialTable(N - 1, s);
  const joint = new Float64Array(9); // index 3 * halfTimeOutcome + fullTimeOutcome
  const goals = new Float64Array(2 * N - 1); // distribution of H1 + A1
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      const p = M.p[x * N + y];
      if (!(p > 1e-16)) continue;
      const ft = outcome(x, y);
      const bx = bin[x];
      const by = bin[y];
      for (let h = 0; h <= x; h++) {
        const ph = p * bx[h];
        for (let a = 0; a <= y; a++) {
          const w = ph * by[a];
          joint[3 * outcome(h, a) + ft] += w;
          goals[h + a] += w;
        }
      }
    }
  }
  const ht = {
    home: joint[0] + joint[1] + joint[2],
    draw: joint[3] + joint[4] + joint[5],
    away: joint[6] + joint[7] + joint[8],
  };
  let mean = 0;
  for (let k = 0; k < goals.length; k++) mean += k * goals[k];
  const totals = FIRST_HALF_LINES.map((line) => {
    let over = 0;
    let under = 0;
    for (let k = 0; k < goals.length; k++) {
      if (k > line) over += goals[k];
      else under += goals[k];
    }
    return { line, over, under };
  });
  return { s, ht, htft: Array.from(joint), firstHalf: { mean, totals } };
}

/** The three half-time results as an array [home, draw, away] (for scoring). */
export const htArray = (mk) => [mk.ht.home, mk.ht.draw, mk.ht.away];

/** Index into HTFT_KEYS of an observed (half-time score, full-time score). */
export function htftIndex(hthg, htag, x, y) {
  return 3 * outcome(hthg, htag) + outcome(x, y);
}

/** Half-time outcome index (0 home, 1 draw, 2 away) of a half-time score. */
export const htOutcomeIndex = (hthg, htag) => outcome(hthg, htag);

/** Base rates of the half-time markets from a training sample (add-one smoothing), for the back-test. */
export function htBaseRates(train) {
  const ht = [0, 0, 0];
  const joint = new Array(9).fill(0);
  const fh = { over05: 0, over15: 0 };
  let n = 0;
  for (const m of train) {
    const { hthg, htag, x, y } = m;
    if (!Number.isInteger(hthg) || !Number.isInteger(htag) || hthg > x || htag > y || hthg < 0 || htag < 0) continue;
    n++;
    ht[outcome(hthg, htag)]++;
    joint[htftIndex(hthg, htag, x, y)]++;
    if (hthg + htag >= 1) fh.over05++;
    if (hthg + htag >= 2) fh.over15++;
  }
  return {
    n,
    ht: ht.map((c) => (c + 1) / (n + 3)),
    joint: joint.map((c) => (c + 1) / (n + 9)),
    over05: (fh.over05 + 1) / (n + 2),
    over15: (fh.over15 + 1) / (n + 2),
  };
}

/** The JSON block of the HT/FT markets of one fixture (compact: `combos` follows HTFT_KEYS). */
export function htftBlock(mk) {
  return { s: mk.s, ht: mk.ht, combos: mk.htft, firstHalf: mk.firstHalf };
}
