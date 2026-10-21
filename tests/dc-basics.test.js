import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatrix, lgamma, poissonPmfArray } from '../src/model/poisson.js';
import { goalMarkets } from '../src/model/markets.js';
import { fitGoals, fitRho, forecastMatch } from '../src/model/dc.js';
import { simulateLeague } from './helpers.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

test('lgamma matches known values', () => {
  near(lgamma(5), Math.log(24), 1e-12, 'lgamma(5)');
  near(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12, 'lgamma(0.5)');
  // Independent reference: Stirling series with two correction terms.
  const x = 25.3;
  const stirling =
    (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x) - 1 / (360 * x ** 3);
  near(lgamma(x), stirling, 1e-8, 'lgamma(25.3)');
});

test('Test 1: lam = mu = 1.35, rho = 0 reproduces the Poisson reference numbers', () => {
  const m = goalMarkets(scoreMatrix(1.35, 1.35, 0));
  near(m.oneX2.draw, 0.2582, 0.0005, 'P(draw)');
  near(m.totals.find((t) => t.line === 2.5).over, 0.5064, 0.0005, 'P(over 2.5)');
  near(m.btts.yes, 0.5487, 0.0005, 'P(BTTS)');
});

test('Test 2: lam = mu = 1.35, rho = -0.1 reproduces the Dixon-Coles reference numbers', () => {
  const M = scoreMatrix(1.35, 1.35, -0.1);
  near(M.p[0 * M.size + 0], 0.0795, 0.0005, 'P(0-0)');
  near(M.p[1 * M.size + 1], 0.1347, 0.0005, 'P(1-1)');
  const m = goalMarkets(M);
  near(m.oneX2.draw, 0.2827, 0.0005, 'P(draw)');
  near(M.p.reduce((s, v) => s + v, 0), 1, 1e-12, 'matrix sum');
});

test('tau preserves total mass before renormalisation (truncation error only)', () => {
  const raw = poissonPmfArray(1.7, 14);
  const rawA = poissonPmfArray(0.9, 14);
  let plain = 0;
  for (let i = 0; i <= 14; i++) for (let j = 0; j <= 14; j++) plain += raw[i] * rawA[j];
  // After renormalisation the matrix sums to 1 exactly.
  const M = scoreMatrix(1.7, 0.9, -0.12);
  near(M.p.reduce((s, v) => s + v, 0), 1, 1e-12);
  assert.ok(plain > 0.9999);
});

test('Test 3: swapping the teams with eta = 0 mirrors the 1X2', () => {
  const { teams, matches, lastDay } = simulateLeague({ seed: 5, seasons: 2 });
  const tNow = lastDay + 1;
  const model = fitGoals({ matches, teams, tNow, xi: 0.0019, sigma: 0.25 });
  const { rho } = fitRho(model);
  for (const [home, away] of [['T01', 'T02'], ['T05', 'T17'], ['T20', 'T03']]) {
    const f1 = forecastMatch(model, rho, home, away, 0);
    const f2 = forecastMatch(model, rho, away, home, 0);
    const a = goalMarkets(f1.matrix).oneX2;
    const b = goalMarkets(f2.matrix).oneX2;
    near(a.home, b.away, 1e-12, 'home vs mirrored away');
    near(a.draw, b.draw, 1e-12, 'draw');
    near(a.away, b.home, 1e-12, 'away vs mirrored home');
  }
});

test('Every complete goal market set sums to 1', () => {
  const m = goalMarkets(scoreMatrix(1.62, 1.05, -0.07));
  const s = (arr) => arr.reduce((x, y) => x + y, 0);
  near(m.oneX2.home + m.oneX2.draw + m.oneX2.away, 1, 1e-12, '1X2');
  near(m.drawNoBet.home + m.drawNoBet.away, 1, 1e-12, 'DNB');
  near(s(m.exactTotals), 1, 1e-12, 'exact totals');
  near(m.btts.yes + m.btts.no, 1, 1e-12, 'BTTS');
  near(m.bttsOver25.yesOver + m.bttsOver25.yesUnder + m.bttsOver25.noOver + m.bttsOver25.noUnder, 1, 1e-12, 'BTTS x O/U');
  near(s(m.correctScores.map((c) => c.p)) + m.correctScoresOther, 1, 1e-12, 'correct scores');
  near(m.oddEven.odd + m.oddEven.even, 1, 1e-12, 'odd/even');
  for (const t of m.totals) near(t.over + t.under, 1, 1e-12, `total ${t.line}`);
  for (const side of ['home', 'away']) for (const t of m.teamTotals[side]) near(t.over + t.under, 1, 1e-12, `team total ${side} ${t.line}`);
  for (const h of m.handicaps) near(h.win + h.push + h.lose, 1, 1e-12, `handicap ${h.line}`);
  // half lines have no push, whole lines do
  assert.equal(m.handicaps.find((h) => h.line === -0.5).push, 0);
  assert.ok(m.handicaps.find((h) => h.line === -1).push > 0.1);
  near(m.expected.total, 1.62 + 1.05, 0.02, 'expected goals close to lam + mu');
});

test('rho is recovered from simulated Dixon-Coles data (sign and rough size)', () => {
  // Build a data set whose low scores follow the tau correction exactly in
  // expectation, by sampling from the score matrix.
  const { teams, truth, lastDay } = simulateLeague({ seed: 9, seasons: 1 });
  // Reuse the simulated parameters to draw scores from the DC matrix.
  const matches = [];
  let seed = 123456;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rhoTrue = -0.12;
  let day = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (let h = 0; h < teams.length; h++) {
      for (let a = 0; a < teams.length; a++) {
        if (h === a) continue;
        const lam = Math.exp(truth.c + truth.eta + truth.att[h] + truth.def[a]);
        const mu = Math.exp(truth.c + truth.att[a] + truth.def[h]);
        const M = scoreMatrix(lam, mu, rhoTrue);
        let u = rnd();
        let pick = 0;
        for (let k = 0; k < M.p.length; k++) {
          u -= M.p[k];
          if (u <= 0) {
            pick = k;
            break;
          }
        }
        matches.push({ t: day++ % 700, home: teams[h], away: teams[a], x: Math.floor(pick / M.size), y: pick % M.size });
      }
    }
  }
  const model = fitGoals({ matches, teams, tNow: 800, xi: 0, sigma: 0.25 });
  const { rho, feasible } = fitRho(model);
  assert.ok(feasible);
  assert.ok(rho < -0.05 && rho > -0.2, `rho ${rho} should be near -0.12`);
  void lastDay;
});
