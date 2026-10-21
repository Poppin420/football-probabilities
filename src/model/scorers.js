// Anytime / 2+ / first goalscorer probabilities by exact thinning of the
// team-goals distribution.
//
//   g_p   = (G0 + 0.5 G1 + a) / (N0 + 0.5 N1 + b)        per team-match
//   lam_p = g_p * lam_T / lamBar_T,  sum_p lam_p <= 0.97 lam_T
//   q_p   = lam_p / lam_T
//   P(anytime) = 1 - sum_n P(N_T = n) (1 - q_p)^n
//   P(2+)      = 1 - P(0) - sum_n P(N_T = n) n q_p (1 - q_p)^(n-1)
//   P(first)   = q_p * lam_T / (lam + mu) * (1 - exp(-(lam + mu)))

import { lgamma } from './poisson.js';

export const DEFAULT_PRIOR = Object.freeze({ a: 1, b: 12 });
export const CAP = 0.97;

/** Shrunken per-team-match scoring rate. */
export function scorerRate({ G0, G1 = 0, N0, N1 = 0, a = DEFAULT_PRIOR.a, b = DEFAULT_PRIOR.b }) {
  return (G0 + 0.5 * G1 + a) / (N0 + 0.5 * N1 + b);
}

/**
 * Exact thinning: each of the N_T team goals is scored by the player with
 * probability q, independently. pmfN is the team-goals pmf (index = goals).
 * Returns { p0, p1, anytime, twoPlus }.
 */
export function thinning(pmfN, q) {
  if (!(q > 0)) return { p0: 1, p1: 0, anytime: 0, twoPlus: 0 };
  let p0 = 0;
  let p1 = 0;
  for (let n = 0; n < pmfN.length; n++) {
    const pn = pmfN[n];
    p0 += pn * Math.pow(1 - q, n);
    if (n >= 1) p1 += pn * n * q * Math.pow(1 - q, n - 1);
  }
  return { p0, p1, anytime: Math.max(0, 1 - p0), twoPlus: Math.max(0, 1 - p0 - p1) };
}

/** P(player scores the first goal of the match). */
export function firstScorer(q, lamT, lam, mu) {
  return q * (lamT / (lam + mu)) * (1 - Math.exp(-(lam + mu)));
}

/**
 * Scorer probabilities for one team in one match.
 *
 * players: [{ name, G0, G1, sameClub }] - G1 counts only when sameClub.
 * N0 / N1: the club's matches this / last season (from the CSVs).
 * lamT: the team's expected goals in this match (lam for home, mu for away).
 * lamBarT: the team's weighted goals per match over the same window.
 * pmfN: team-goals pmf from the score matrix (exact, no Poisson assumption).
 * lam, mu: both expected-goal values of the fixture (for P(first)).
 * absent: optional Set of lower-case player names to be zeroed (injuries).
 *
 * Phase 3 (API-Football injuries): a player entry may also carry
 *   absent: true      -> lam_p = 0 (suspended / injured: "Missing Fixture"), listed apart by the caller
 *   doubtful: true    -> kept in the list, only tagged ("Questionable")
 *   kind: string      -> 'injury' | 'suspension' | 'other', passed through for the UI
 * Every output entry has `absent`, `doubtful`, `kind` and `preRank` (0-based rank by scoring rate BEFORE the
 * absences, so the caller can show only the absentees who would have been among the top scorers).
 */
export function teamScorerProbs({
  players,
  N0,
  N1,
  lamT,
  lamBarT,
  pmfN,
  lam,
  mu,
  a = DEFAULT_PRIOR.a,
  b = DEFAULT_PRIOR.b,
  absent = null,
}) {
  if (!(lamT > 0) || !(lamBarT > 0)) return { players: [], capped: false, sumRate: 0 };

  const rows = players.map((p) => {
    const g = scorerRate({ G0: p.G0, G1: p.sameClub ? p.G1 || 0 : 0, N0, N1, a, b });
    const isAbsent = p.absent === true || Boolean(absent && absent.has(String(p.name).toLowerCase()));
    const lamP = isAbsent ? 0 : (g * lamT) / lamBarT;
    return { name: p.name, goals: p.G0, lamP, rate: g, absent: isAbsent, doubtful: !isAbsent && p.doubtful === true, kind: p.kind ?? null };
  });
  // rank by scoring rate before the absences (the rate does not depend on the cap or on the absentees)
  const byRate = rows.slice().sort((x, y) => y.rate - x.rate || x.name.localeCompare(y.name));
  byRate.forEach((r, i) => {
    r.preRank = i;
  });

  let sum = rows.reduce((s, r) => s + r.lamP, 0);
  let capped = false;
  if (sum > CAP * lamT) {
    const scale = (CAP * lamT) / sum;
    for (const r of rows) r.lamP *= scale;
    sum = CAP * lamT;
    capped = true;
  }

  const out = rows.map((r) => {
    const q = r.lamP / lamT;
    const t = thinning(pmfN, q);
    return {
      name: r.name,
      goals: r.goals,
      rate: r.rate,
      lamP: r.lamP,
      q,
      anytime: t.anytime,
      twoPlus: t.twoPlus,
      first: firstScorer(q, lamT, lam, mu),
      absent: r.absent,
      doubtful: r.doubtful,
      kind: r.kind,
      preRank: r.preRank,
    };
  });
  out.sort((x, y) => y.anytime - x.anytime || x.name.localeCompare(y.name));
  return { players: out, capped, sumRate: sum };
}

// ---------------------------------------------------------------------------
// Empirical-Bayes Gamma prior (a, b) for the per-match scoring rate (Phase 2).
//
// A listed scorer has G goals in N club matches. Model: G | theta ~ Poisson(N * theta),
// theta ~ Gamma(shape a, rate b), so G is negative binomial:
//   P(G = g) = Gamma(g + a) / (Gamma(a) g!) * (b / (b + N))^a * (N / (b + N))^g
// Only players with at least L goals are listed (L = 1; or one more than the
// smallest listed count when the list is cut at its size limit), so the
// likelihood is the zero-truncated one: P(g) / (1 - sum_{j < L} P(j)).
// (a, b) maximise it over the listed players of ONE league (current season).

export const PRIOR_BOUNDS = Object.freeze({ aMin: 0.25, aMax: 5, bMin: 2.5, bMax: 80 });
const MIN_PLAYERS = 40;
const MIN_MEDIAN_MATCHES = 8;

function nbLogPmf(g, n, a, b) {
  return lgamma(g + a) - lgamma(a) - lgamma(g + 1) + a * Math.log(b / (b + n)) + g * Math.log(n / (b + n));
}

/** Log-likelihood of the truncated model; players = [{ g, n }], lower = smallest possible g. */
export function truncatedLogLik(players, a, b, lower = 1) {
  let ll = 0;
  for (const { g, n } of players) {
    let mass = 0; // P(G < lower)
    for (let j = 0; j < lower; j++) mass += Math.exp(nbLogPmf(j, n, a, b));
    ll += nbLogPmf(g, n, a, b) - Math.log(Math.max(1e-300, 1 - mass));
  }
  return ll;
}

/**
 * @param {{g:number, n:number}[]} pairs   goals and club matches of every listed player (current season)
 * @param {{listLength?:number, limit?:number}} [opts]  limit = size cap of the list (200)
 * @returns {{ok:boolean, a:number, b:number, source:'eb'|'default', n:number, lower:number, reason:string, logLik?:number}}
 */
export function fitScorerPrior(pairs, { listLength = pairs.length, limit = 200 } = {}) {
  const fallback = (reason) => ({ ok: false, a: DEFAULT_PRIOR.a, b: DEFAULT_PRIOR.b, source: 'default', n: pairs.length, lower: 1, reason });
  const usable = pairs.filter((p) => Number.isFinite(p.g) && p.g >= 1 && Number.isFinite(p.n) && p.n > 0);
  if (usable.length < MIN_PLAYERS) return fallback(`only ${usable.length} listed players`);
  const sortedN = usable.map((p) => p.n).sort((x, y) => x - y);
  if (sortedN[Math.floor(sortedN.length / 2)] < MIN_MEDIAN_MATCHES) return fallback('too early in the season');

  // The list is cut at `limit`: players with the smallest listed count may be missing.
  let lower = 1;
  let data = usable;
  if (listLength >= limit) {
    lower = Math.min(...usable.map((p) => p.g)) + 1;
    data = usable.filter((p) => p.g >= lower);
    if (data.length < MIN_PLAYERS) return fallback('list cut too high');
  }

  const { aMin, aMax, bMin, bMax } = PRIOR_BOUNDS;
  const ll = (la, lb) => truncatedLogLik(data, Math.exp(la), Math.exp(lb), lower);
  // coarse log-grid, then alternating golden-section refinement
  let best = { la: 0, lb: Math.log(12), v: -Infinity };
  const G = 24;
  for (let i = 0; i <= G; i++) {
    for (let j = 0; j <= G; j++) {
      const la = Math.log(aMin) + ((Math.log(aMax) - Math.log(aMin)) * i) / G;
      const lb = Math.log(bMin) + ((Math.log(bMax) - Math.log(bMin)) * j) / G;
      const v = ll(la, lb);
      if (v > best.v) best = { la, lb, v };
    }
  }
  const golden = (fn, lo, hi) => {
    const phi = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - phi * (hi - lo);
    let x2 = lo + phi * (hi - lo);
    let f1 = fn(x1);
    let f2 = fn(x2);
    for (let it = 0; it < 40; it++) {
      if (f1 > f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - phi * (hi - lo);
        f1 = fn(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + phi * (hi - lo);
        f2 = fn(x2);
      }
    }
    return (lo + hi) / 2;
  };
  const stepA = (Math.log(aMax) - Math.log(aMin)) / G;
  const stepB = (Math.log(bMax) - Math.log(bMin)) / G;
  for (let round = 0; round < 3; round++) {
    best.la = golden((x) => ll(x, best.lb), Math.max(Math.log(aMin), best.la - stepA), Math.min(Math.log(aMax), best.la + stepA));
    best.lb = golden((x) => ll(best.la, x), Math.max(Math.log(bMin), best.lb - stepB), Math.min(Math.log(bMax), best.lb + stepB));
  }
  const a = Math.exp(best.la);
  const b = Math.exp(best.lb);
  const edge = a <= aMin * 1.02 || a >= aMax / 1.02 || b <= bMin * 1.02 || b >= bMax / 1.02;
  if (edge) return fallback(`estimate on the boundary (a=${a.toFixed(2)}, b=${b.toFixed(1)})`);
  return { ok: true, a, b, source: 'eb', n: data.length, lower, reason: 'zero-truncated negative-binomial maximum likelihood', logLik: ll(best.la, best.lb) };
}
