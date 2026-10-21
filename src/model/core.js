// The three "main markets" read straight from a score matrix (cheap: no
// sorting, no allocation). Used by the bootstrap, the back-test and the
// calibration layer; goalMarkets() in markets.js stays the full version.

/** { pH, pD, pA, pOver25, pBtts } of a score matrix { size, p }. */
export function coreProbs(M) {
  const N = M.size;
  const P = M.p;
  let pH = 0;
  let pD = 0;
  let pA = 0;
  let over = 0;
  let btts = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = P[i * N + j];
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j >= 3) over += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  return { pH, pD, pA, pOver25: over, pBtts: btts };
}

/** 0 = home win, 1 = draw, 2 = away win. */
export function outcomeIndex(x, y) {
  return x > y ? 0 : x === y ? 1 : 2;
}
