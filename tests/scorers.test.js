import test from 'node:test';
import assert from 'node:assert/strict';
import { thinning, firstScorer, scorerRate, teamScorerProbs } from '../src/model/scorers.js';
import { poissonPmfArray, scoreMatrix } from '../src/model/poisson.js';
import { goalMarkets } from '../src/model/markets.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

test('Test 7: thinning equals 1 - exp(-lam_p) when N_T is Poisson', () => {
  for (const [lamT, q] of [[1.7, 0.25], [0.9, 0.4], [2.4, 0.08], [1.3, 0.6]]) {
    const pmf = poissonPmfArray(lamT, 60);
    const t = thinning(pmf, q);
    near(t.anytime, 1 - Math.exp(-q * lamT), 1e-12, `anytime lamT=${lamT} q=${q}`);
    // P(2+) for a Poisson(lam_p): 1 - exp(-l)(1 + l)
    const l = q * lamT;
    near(t.twoPlus, 1 - Math.exp(-l) * (1 + l), 1e-12, 'two plus');
  }
});

test('thinning works for a non-Poisson team-goals pmf from the Dixon-Coles matrix', () => {
  const m = goalMarkets(scoreMatrix(1.4, 1.1, -0.1));
  const t = thinning(m.marginals.home, 0.3);
  assert.ok(t.anytime > 0 && t.anytime < 1);
  assert.ok(t.twoPlus < t.anytime);
  // q = 1: the player scores every goal, so P(anytime) = P(N >= 1)
  near(thinning(m.marginals.home, 1).anytime, 1 - m.marginals.home[0], 1e-12);
});

test('scorer rate uses the fixed prior a = 1, b = 12 by default', () => {
  near(scorerRate({ G0: 5, G1: 10, N0: 8, N1: 38 }), (5 + 5 + 1) / (8 + 19 + 12), 1e-12);
  near(scorerRate({ G0: 0, G1: 0, N0: 0, N1: 0 }), 1 / 12, 1e-12);
});

test('team scorer probabilities respect the 0.97 cap and the first-scorer formula', () => {
  const lam = 1.8;
  const mu = 1.0;
  const m = goalMarkets(scoreMatrix(lam, mu, -0.05));
  const players = [
    { name: 'A', G0: 9, G1: 20, sameClub: true },
    { name: 'B', G0: 7, G1: 0, sameClub: false },
    { name: 'C', G0: 6, G1: 10, sameClub: true },
    { name: 'D', G0: 5, G1: 8, sameClub: true },
  ];
  // lamBarT small relative to player rates forces the cap
  const res = teamScorerProbs({
    players,
    N0: 9,
    N1: 38,
    lamT: lam,
    lamBarT: 0.9,
    pmfN: m.marginals.home,
    lam,
    mu,
  });
  assert.equal(res.capped, true);
  near(res.sumRate, 0.97 * lam, 1e-12, 'capped sum');
  const sumQ = res.players.reduce((s, p) => s + p.q, 0);
  near(sumQ, 0.97, 1e-12, 'sum of shares');
  const p0 = res.players[0];
  near(p0.first, p0.q * (lam / (lam + mu)) * (1 - Math.exp(-(lam + mu))), 1e-12, 'first scorer');
  // sorted by anytime probability
  for (let i = 1; i < res.players.length; i++) assert.ok(res.players[i - 1].anytime >= res.players[i].anytime);
  // first-scorer probabilities of both squads cannot exceed P(any goal)
  assert.ok(res.players.reduce((s, p) => s + p.first, 0) <= 1);
});

test('absent players get probability zero and the others are unchanged by the cap', () => {
  const lam = 1.5;
  const mu = 1.2;
  const m = goalMarkets(scoreMatrix(lam, mu, 0));
  const base = teamScorerProbs({
    players: [{ name: 'Star', G0: 3, G1: 0, sameClub: false }, { name: 'Other', G0: 1, G1: 0, sameClub: false }],
    N0: 8,
    N1: 0,
    lamT: lam,
    lamBarT: 1.5,
    pmfN: m.marginals.home,
    lam,
    mu,
  });
  const out = teamScorerProbs({
    players: [{ name: 'Star', G0: 3, G1: 0, sameClub: false }, { name: 'Other', G0: 1, G1: 0, sameClub: false }],
    N0: 8,
    N1: 0,
    lamT: lam,
    lamBarT: 1.5,
    pmfN: m.marginals.home,
    lam,
    mu,
    absent: new Set(['star']),
  });
  assert.equal(out.players.find((p) => p.name === 'Star').anytime, 0);
  near(
    out.players.find((p) => p.name === 'Other').anytime,
    base.players.find((p) => p.name === 'Other').anytime,
    1e-12,
  );
});

test('firstScorer formula', () => {
  near(firstScorer(0.3, 1.6, 1.6, 1.0), 0.3 * (1.6 / 2.6) * (1 - Math.exp(-2.6)), 1e-15);
});
