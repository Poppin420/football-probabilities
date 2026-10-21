// Markets derived from a score matrix (goals) or from count pmfs
// (corners, cards). Every complete set sums to 1 (to ~1e-12).

import { convolve, tailOver } from './negbin.js';

const GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
const TEAM_GOAL_LINES = [0.5, 1.5, 2.5];
const HANDICAP_LINES = [-1.5, -1, -0.5, 0.5, 1, 1.5];

/** All goal markets from a score matrix { size, p }. */
export function goalMarkets(M) {
  const N = M.size;
  const P = M.p;
  let pH = 0;
  let pD = 0;
  let pA = 0;
  const homeMarg = new Float64Array(N);
  const awayMarg = new Float64Array(N);
  const totals = new Float64Array(2 * N - 1);
  const diff = new Float64Array(2 * N - 1); // index d + N - 1
  let odd = 0;
  let yesOver = 0;
  let yesUnder = 0;
  let noOver = 0;
  let noUnder = 0;
  let winToNilHome = 0;
  let winToNilAway = 0;
  let expHome = 0;
  let expAway = 0;
  const cells = [];

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = P[i * N + j];
      homeMarg[i] += p;
      awayMarg[j] += p;
      totals[i + j] += p;
      diff[i - j + N - 1] += p;
      expHome += i * p;
      expAway += j * p;
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if ((i + j) % 2 === 1) odd += p;
      const btts = i > 0 && j > 0;
      const over = i + j >= 3;
      if (btts && over) yesOver += p;
      else if (btts) yesUnder += p;
      else if (over) noOver += p;
      else noUnder += p;
      if (j === 0 && i > 0) winToNilHome += p;
      if (i === 0 && j > 0) winToNilAway += p;
      cells.push({ home: i, away: j, p });
    }
  }

  const totalLines = (marg, lines) =>
    lines.map((line) => {
      const over = tailOver(marg, line);
      let under = 0;
      for (let k = 0; k < marg.length; k++) if (k < line) under += marg[k];
      return { line, over, under };
    });

  const exactTotals = [];
  for (let k = 0; k < 6; k++) exactTotals.push(totals[k]);
  let six = 0;
  for (let k = 6; k < totals.length; k++) six += totals[k];
  exactTotals.push(six);

  cells.sort((a, b) => b.p - a.p || a.home - b.home || a.away - b.away);
  const top = cells.slice(0, 8).map((c) => ({ score: `${c.home}-${c.away}`, home: c.home, away: c.away, p: c.p }));
  const topSum = top.reduce((s, c) => s + c.p, 0);

  const handicaps = HANDICAP_LINES.map((line) => {
    let win = 0;
    let push = 0;
    let lose = 0;
    for (let d = -(N - 1); d <= N - 1; d++) {
      const v = diff[d + N - 1];
      const adj = d + line;
      if (adj > 1e-9) win += v;
      else if (adj < -1e-9) lose += v;
      else push += v;
    }
    return { line, win, push, lose };
  });

  return {
    oneX2: { home: pH, draw: pD, away: pA },
    doubleChance: { homeDraw: pH + pD, homeAway: pH + pA, drawAway: pD + pA },
    drawNoBet: { home: pH / (pH + pA), away: pA / (pH + pA), push: pD },
    totals: totalLines(totals, GOAL_LINES),
    exactTotals,
    btts: { yes: yesOver + yesUnder, no: noOver + noUnder },
    bttsOver25: { yesOver, yesUnder, noOver, noUnder },
    correctScores: top,
    correctScoresOther: 1 - topSum,
    teamTotals: {
      home: totalLines(homeMarg, TEAM_GOAL_LINES),
      away: totalLines(awayMarg, TEAM_GOAL_LINES),
    },
    cleanSheet: { home: awayMarg[0], away: homeMarg[0] },
    winToNil: { home: winToNilHome, away: winToNilAway },
    handicaps,
    oddEven: { odd, even: 1 - odd },
    expected: { home: expHome, away: expAway, total: expHome + expAway },
    marginals: { home: homeMarg, away: awayMarg },
  };
}

// ---------------------------------------------------------------------------
// Corners

const CORNER_TOTAL_LINES = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5];
const CORNER_TEAM_LINES = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
const CORNER_HANDICAPS = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5];

function pmfMeanLocal(p) {
  let s = 0;
  for (let k = 0; k < p.length; k++) s += k * p[k];
  return s;
}

function overUnder(pmf, lines) {
  return lines.map((line) => {
    const over = tailOver(pmf, line);
    let under = 0;
    for (let k = 0; k < pmf.length; k++) if (k < line) under += pmf[k];
    return { line, over, under };
  });
}

/** Difference distribution D = H - A, index d + (nA - 1). */
function diffDistribution(pH, pA) {
  const nA = pA.length;
  const out = new Float64Array(pH.length + nA - 1);
  for (let i = 0; i < pH.length; i++) {
    for (let j = 0; j < nA; j++) out[i - j + nA - 1] += pH[i] * pA[j];
  }
  return { dist: out, offset: nA - 1 };
}

export function cornerMarkets(pH, pA) {
  const total = convolve(pH, pA);
  const { dist, offset } = diffDistribution(pH, pA);
  const handicaps = CORNER_HANDICAPS.map((line) => {
    let win = 0;
    let lose = 0;
    for (let k = 0; k < dist.length; k++) {
      const adj = k - offset + line;
      if (adj > 0) win += dist[k];
      else lose += dist[k];
    }
    return { line, win, lose };
  });
  let more = 0;
  let equal = 0;
  let less = 0;
  for (let k = 0; k < dist.length; k++) {
    const d = k - offset;
    if (d > 0) more += dist[k];
    else if (d === 0) equal += dist[k];
    else less += dist[k];
  }
  return {
    totals: overUnder(total, CORNER_TOTAL_LINES),
    teamTotals: { home: overUnder(pH, CORNER_TEAM_LINES), away: overUnder(pA, CORNER_TEAM_LINES) },
    handicaps,
    more: { home: more, equal, away: less },
    mean: { home: pmfMeanLocal(pH), away: pmfMeanLocal(pA), total: pmfMeanLocal(total) },
  };
}

// ---------------------------------------------------------------------------
// Cards

const CARD_TOTAL_LINES = [2.5, 3.5, 4.5, 5.5, 6.5];
const BOOKING_POINT_LINES = [20.5, 30.5, 40.5, 50.5, 60.5];

/**
 * yH, yA: yellow-card pmfs; rH, rA: red-card pmfs.
 * Total cards T = Y_h + Y_a + R_h + R_a by exact convolution.
 * Booking points (10 per yellow, 25 per red) are optional extras.
 */
export function cardMarkets({ yH, yA, rH, rA }) {
  const yTot = convolve(yH, yA);
  const rTot = convolve(rH, rA);
  const total = convolve(yTot, rTot);

  // Booking points in units of 5: yellow = 2 units, red = 5 units.
  const units = new Float64Array(2 * (yTot.length - 1) + 5 * (rTot.length - 1) + 1);
  for (let y = 0; y < yTot.length; y++) {
    for (let r = 0; r < rTot.length; r++) units[2 * y + 5 * r] += yTot[y] * rTot[r];
  }
  const bookingPoints = BOOKING_POINT_LINES.map((line) => {
    let over = 0;
    for (let u = 0; u < units.length; u++) if (u * 5 > line) over += units[u];
    return { line, over, under: 1 - over };
  });

  return {
    totals: overUnder(total, CARD_TOTAL_LINES),
    bookingPoints,
    mean: {
      total: pmfMeanLocal(total),
      yellowHome: pmfMeanLocal(yH),
      yellowAway: pmfMeanLocal(yA),
      redHome: pmfMeanLocal(rH),
      redAway: pmfMeanLocal(rA),
    },
  };
}
