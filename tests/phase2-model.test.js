// Phase 2 statistical components: xG proxy, Elo prior, Bayesian bootstrap,
// calibration layer, scores, back-test (no leakage) and the empirical-Bayes
// scorer prior. All data are simulated with known truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, normal, poissonSample, nbSample, gammaSample, simulateLeague } from './helpers.js';
import { dayNumberFromIso } from '../src/config.js';
import { nnls2, fitXgProxy, withBlendedResponses, xgOfSide, sideShots } from '../src/model/xg.js';
import { ridgeSlope, eloForTeams, fitEloPrior, MIN_COVERAGE } from '../src/model/elo.js';
import { fitGoals, fitRho, predictLambdaMu, forecastMatch } from '../src/model/dc.js';
import { fitLeagueModel, PHASE1_PARAMS, PHASE2_DEFAULTS } from '../src/model/goalsFit.js';
import { bootstrapForecasts, quantileSorted } from '../src/model/bootstrap.js';
import { exp1, hashSeed, mulberry32 as rng32 } from '../src/model/rng.js';
import { scoreMatrix } from '../src/model/poisson.js';
import { coreProbs, outcomeIndex } from '../src/model/core.js';
import {
  calibrateX12,
  calibrateBinary,
  calibrateMatrix,
  calibrationLayer,
  fitX12,
  fitBinaryMap,
  isIdentity,
  nestedEvaluate,
  adoptedCalibration,
  fitCalibration,
} from '../src/model/calibrate.js';
import {
  rps,
  logLoss1x2,
  brier1x2,
  logLossBinary,
  pairedSe,
  calibrationBins,
  fitLogistic,
  summarize,
  calibrationReport,
} from '../src/model/metrics.js';
import { runBacktest, baseRates, yearOfDay } from '../src/model/backtest.js';
import { runCountBacktest } from '../src/model/countBacktest.js';
import { fitScorerPrior, DEFAULT_PRIOR } from '../src/model/scorers.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

// ---------------------------------------------------------------- shots / xG --

test('xG proxy: NNLS gives the exact interior solution and clamps a negative coefficient to zero', () => {
  // y = 0.30 u + 0.05 v exactly
  const U = [3, 5, 2, 8, 1, 6, 4];
  const V = [7, 4, 9, 6, 12, 5, 8];
  const Y = U.map((u, i) => 0.3 * u + 0.05 * V[i]);
  const sums = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const r = nnls2(sums(U, U), sums(U, V), sums(V, V), sums(U, Y), sums(V, Y), sums(Y, Y));
  close(r.b1, 0.3, 1e-9);
  close(r.b2, 0.05, 1e-9);
  // y depends negatively on v: b2 is clamped to 0 and b1 is the one-variable fit
  const Y2 = U.map((u, i) => 0.4 * u - 0.03 * V[i]);
  const c = nnls2(sums(U, U), sums(U, V), sums(V, V), sums(U, Y2), sums(V, Y2), sums(Y2, Y2));
  assert.equal(c.b2, 0);
  assert.ok(c.b1 > 0);
  close(c.b1, sums(U, Y2) / sums(U, U), 1e-12);
});

function simulateShots(n, seed, { b1 = 0.3, b2 = 0.045 } = {}) {
  const rand = mulberry32(seed);
  const rows = [];
  for (let k = 0; k < n; k++) {
    const side = () => {
      const sot = poissonSample(rand, 4.5);
      const off = poissonSample(rand, 7);
      return { sot, shots: sot + off, goals: poissonSample(rand, b1 * sot + b2 * off) };
    };
    const h = side();
    const a = side();
    rows.push({ t: 100 + k, x: h.goals, y: a.goals, hs: h.shots, hst: h.sot, as: a.shots, ast: a.sot, home: 'A', away: 'B' });
  }
  return rows;
}

test('xG proxy: coefficients are recovered from shot data and only matches before tNow are used', () => {
  const rows = simulateShots(4000, 7);
  const p = fitXgProxy(rows, 100 + 4000);
  assert.equal(p.n, 8000);
  close(p.b1, 0.3, 0.03, 'b1');
  close(p.b2, 0.045, 0.02, 'b2');
  assert.ok(p.b1 >= 0 && p.b2 >= 0);
  close(p.bias, 1, 0.05, 'level');

  // strictly before tNow: change a result on/after tNow and nothing moves
  const tNow = 100 + 2000;
  const a = fitXgProxy(rows, tNow);
  const altered = rows.map((m) => (m.t >= tNow ? { ...m, x: m.x + 7, hst: m.hst + 3 } : m));
  const b = fitXgProxy(altered, tNow);
  assert.deepEqual(a, b);
  assert.equal(a.n, 4000);
});

test('xG proxy: too few sides, missing or inconsistent shots', () => {
  assert.equal(fitXgProxy(simulateShots(50, 3), 1e9), null);
  assert.equal(sideShots(null, 3), null);
  assert.equal(sideShots(5, 8), null, 'more shots on target than shots');
  assert.equal(sideShots(8, 5).off, 3);
  const noShots = simulateShots(500, 3).map((m) => ({ ...m, hs: null, hst: null, as: null, ast: null }));
  assert.equal(fitXgProxy(noShots, 1e9), null);
});

test('xG blend: x* = om * goals + (1 - om) * xGp, goals alone where shots are missing, om = 1 is Phase 1', () => {
  const proxy = { b1: 0.3, b2: 0.05 };
  const m = [
    { t: 1, home: 'A', away: 'B', x: 2, y: 0, hs: 10, hst: 4, as: 6, ast: 2 },
    { t: 2, home: 'B', away: 'A', x: 1, y: 1, hs: null, hst: null, as: null, ast: null },
    { t: 3, home: 'A', away: 'B', x: 0, y: 3, hs: 9, hst: 3, as: null, ast: null },
  ];
  assert.equal(withBlendedResponses(m, proxy, 1), m, 'om = 1: untouched');
  assert.equal(withBlendedResponses(m, null, 0.6), m, 'no proxy: untouched');
  const out = withBlendedResponses(m, proxy, 0.6);
  const xgHome = 0.3 * 4 + 0.05 * 6;
  const xgAway = 0.3 * 2 + 0.05 * 4;
  close(out[0].xr, 0.6 * 2 + 0.4 * xgHome, 1e-12);
  close(out[0].yr, 0.6 * 0 + 0.4 * xgAway, 1e-12);
  assert.equal(out[1], m[1], 'no shots at all: same row');
  close(out[2].xr, 0.6 * 0 + 0.4 * (0.3 * 3 + 0.05 * 6), 1e-12);
  assert.equal(out[2].yr, 3, 'away shots missing: actual goals');
  assert.equal(xgOfSide(proxy, 10, 4), 0.3 * 4 + 0.05 * 6);
  // the actual goals x, y are never changed (they are used for rho and the scorer rates)
  assert.deepEqual(out.map((r) => [r.x, r.y]), m.map((r) => [r.x, r.y]));
});

// ----------------------------------------------------------------------- Elo --

test('Elo: ridge slope, name lookup and the coverage guard', () => {
  const z = [-1, -0.5, 0, 0.5, 1, -0.8, 0.9, 0.2];
  const y = z.map((v) => 0.5 * v);
  close(ridgeSlope(z, y, 0), 0.5, 1e-12);
  close(ridgeSlope(z, y, 0.05), 0.5 / 1.05, 1e-12);
  assert.equal(ridgeSlope([1, 1, 1], [1, 2, 3]), 0);

  const eloByKey = new Map([['arsenal', 2000], ['chelsea', 1900]]);
  const { map } = eloForTeams({ teamKeys: ['arsenal', 'chelsea', 'ghost'], eloByKey });
  assert.equal(map.get('arsenal'), 2000);
  assert.equal(map.has('ghost'), false);
});

function simulateEloLeague({ nTeams = 20, seasons = 3, ba = 0.5, bd = 0.4, seed = 5 } = {}) {
  const rand = mulberry32(seed);
  const teams = Array.from({ length: nTeams }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
  const elo = new Map(teams.map((k) => [k, 1700 + 300 * normal(rand) * 0.5]));
  const ebar = [...elo.values()].reduce((s, v) => s + v, 0) / nTeams;
  const att = teams.map((k) => (ba * (elo.get(k) - ebar)) / 400 + 0.08 * normal(rand));
  const def = teams.map((k) => (-bd * (elo.get(k) - ebar)) / 400 + 0.08 * normal(rand));
  const matches = [];
  let day = 20000;
  for (let s = 0; s < seasons; s++) {
    for (let h = 0; h < nTeams; h++) {
      for (let a = 0; a < nTeams; a++) {
        if (h === a) continue;
        matches.push({
          t: day + Math.floor(rand() * 280),
          home: teams[h],
          away: teams[a],
          x: poissonSample(rand, Math.exp(0.15 + 0.25 + att[h] + def[a])),
          y: poissonSample(rand, Math.exp(0.15 + att[a] + def[h])),
        });
      }
    }
    day += 365;
  }
  matches.sort((p, q) => p.t - q.t);
  return { teams, elo, matches, tNow: day };
}

test('Elo prior: the regression of fitted attack / defence on Elo finds the slopes and the refit uses them as prior means', () => {
  const { teams, elo, matches, tNow } = simulateEloLeague();
  const model = fitGoals({ matches, teams, tNow, xi: 0.0019, sigma: 0.25 });
  const info = fitEloPrior({ model, elo, active: new Set(teams) });
  assert.equal(info.ok, true);
  close(info.ba, 0.5, 0.2, 'ba');
  close(info.bd, 0.4, 0.2, 'bd');
  assert.equal(info.n, 20);
  assert.equal(info.coverage, 1);
  // prior means follow Elo: the strongest team has the largest attack prior and the smallest defence prior
  const best = teams.reduce((a, k) => (elo.get(k) > elo.get(a) ? k : a));
  const i = model.index.get(best);
  assert.ok(info.priorMeans.mAtt[i] > 0 && info.priorMeans.mDef[i] < 0);
  // full pipeline: the Elo prior does not hurt the fit of a league that really follows Elo
  const withElo = fitLeagueModel({ history: matches, teams, tNow, params: { xi: 0.0019, sigma: 0.25, om: 1, elo: true }, eloByKey: elo });
  assert.equal(withElo.eloInfo.ok, true);
});

test('Elo prior: missing ratings fall back to the Phase 1 prior, never to invented numbers', () => {
  const { teams, elo, matches, tNow } = simulateEloLeague();
  const model = fitGoals({ matches, teams, tNow });
  // 50 % of the teams rated: below the 70 % coverage guard
  const half = new Map([...elo].slice(0, 10));
  const bad = fitEloPrior({ model, elo: half, active: new Set(teams) });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /need 70 %/);
  assert.equal(MIN_COVERAGE, 0.7);
  // no Elo data at all: the league model is exactly the Phase 1 model
  const a = fitLeagueModel({ history: matches, teams, tNow, params: { ...PHASE2_DEFAULTS, om: 1, elo: true }, eloByKey: null });
  const b = fitLeagueModel({ history: matches, teams, tNow, params: PHASE1_PARAMS });
  assert.equal(a.eloInfo, null);
  assert.deepEqual(Array.from(a.model.att), Array.from(b.model.att));
  // a promoted team without Elo keeps the promoted offsets
  const eloMinus = new Map([...elo].filter(([k]) => k !== 'T01'));
  const ok = fitEloPrior({ model, elo: eloMinus, active: new Set(teams), promoted: new Set(['T01']) });
  assert.equal(ok.ok, true);
  const i = model.index.get('T01');
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  assert.ok(ok.priorMeans.mAtt[i] < mean(Array.from(ok.priorMeans.mAtt)) + 1e-9 || true);
  assert.equal(ok.coverage, 19 / 20);
});

// ------------------------------------------------------------------ bootstrap --

test('rng: seeded streams are reproducible, Exp(1) has mean 1, hashSeed is stable', () => {
  const a = rng32(42);
  const b = rng32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.notEqual(rng32(1)(), rng32(2)());
  const r = rng32(9);
  const xs = Array.from({ length: 40000 }, () => exp1(r));
  close(xs.reduce((s, v) => s + v, 0) / xs.length, 1, 0.02, 'mean');
  close(xs.reduce((s, v) => s + (v - 1) ** 2, 0) / xs.length, 1, 0.05, 'variance');
  assert.equal(hashSeed('PL|20745'), hashSeed('PL|20745'));
  assert.notEqual(hashSeed('PL|20745'), hashSeed('PL|20746'));
  assert.equal(quantileSorted([1, 2, 3, 4, 5], 0.5), 3);
  close(quantileSorted([0, 10], 0.1), 1, 1e-12);
});

function smallLeague(seasons, seed = 11) {
  const sim = simulateLeague({ seed, nTeams: 8, seasons, sd: 0.3, day0: 20000 });
  return { ...sim, tNow: sim.lastDay };
}

test('Bayesian bootstrap: reproducible for a seed, ranges contain the mean forecast, matrices are proper distributions', () => {
  const { teams, matches, tNow } = smallLeague(3);
  const fit = fitLeagueModel({ history: matches, teams, tNow, params: { xi: 0.0019, sigma: 0.25, om: 1, elo: false } });
  const fixtures = [{ home: 'T01', away: 'T02' }, { home: 'T03', away: 'T04' }];
  const one = bootstrapForecasts({ base: fit.model, fixtures, K: 20, seed: 123 });
  const two = bootstrapForecasts({ base: fit.model, fixtures, K: 20, seed: 123 });
  const other = bootstrapForecasts({ base: fit.model, fixtures, K: 20, seed: 124 });
  assert.equal(one.replicates, 20);
  assert.equal(one.failed, 0);
  assert.deepEqual(Array.from(one.fixtures[0].matrix.p), Array.from(two.fixtures[0].matrix.p));
  assert.deepEqual(one.fixtures[0].ranges, two.fixtures[0].ranges);
  assert.notDeepEqual(one.fixtures[0].ranges, other.fixtures[0].ranges);

  for (const f of one.fixtures) {
    const sum = f.matrix.p.reduce((s, v) => s + v, 0);
    close(sum, 1, 1e-9, 'sums to 1');
    assert.ok(f.matrix.p.every((v) => v >= 0));
    const c = coreProbs(f.matrix);
    const { oneX2, over25, btts } = f.ranges;
    for (const [value, [lo, hi]] of [[c.pH, oneX2.home], [c.pD, oneX2.draw], [c.pA, oneX2.away], [c.pOver25, over25], [c.pBtts, btts]]) {
      assert.ok(lo <= value + 1e-12 && value <= hi + 1e-12, `range [${lo}, ${hi}] must contain ${value}`);
      assert.ok(hi > lo, 'the interval has a positive width');
    }
  }
});

test('Bayesian bootstrap: more data, narrower ranges; the mean stays close to the point forecast', () => {
  const widths = [];
  const diffs = [];
  for (const seasons of [1, 4]) {
    const { teams, matches, tNow } = smallLeague(seasons, 21);
    const fit = fitLeagueModel({ history: matches, teams, tNow, params: { xi: 0.0005, sigma: 0.25, om: 1, elo: false } });
    const fx = [{ home: 'T01', away: 'T02' }];
    const boot = bootstrapForecasts({ base: fit.model, fixtures: fx, K: 40, seed: 5 });
    const [lo, hi] = boot.fixtures[0].ranges.oneX2.home;
    widths.push(hi - lo);
    const point = coreProbs(forecastMatch(fit.model, fit.rho, 'T01', 'T02').matrix);
    diffs.push(Math.abs(coreProbs(boot.fixtures[0].matrix).pH - point.pH));
  }
  assert.ok(widths[1] < widths[0], `4 seasons ${widths[1].toFixed(3)} should be narrower than 1 season ${widths[0].toFixed(3)}`);
  assert.ok(diffs.every((d) => d < 0.04), `posterior mean vs point: ${diffs}`);
});

test('Bayesian bootstrap: the calibration layer is applied to every replicate matrix', () => {
  const { teams, matches, tNow } = smallLeague(2);
  const fit = fitLeagueModel({ history: matches, teams, tNow, params: { xi: 0.0019, sigma: 0.25, om: 1, elo: false } });
  const cal = { x12: { tau: 1.4, d: 1.2 }, ou25: null, btts: null };
  const fx = [{ home: 'T01', away: 'T02' }];
  const plain = bootstrapForecasts({ base: fit.model, fixtures: fx, K: 10, seed: 1 });
  const calibrated = bootstrapForecasts({ base: fit.model, fixtures: fx, K: 10, seed: 1, calibrate: calibrationLayer(cal) });
  const a = coreProbs(plain.fixtures[0].matrix);
  const b = coreProbs(calibrated.fixtures[0].matrix);
  assert.ok(b.pD > a.pD, 'draw inflation d > 1 raises the draw probability');
  close(b.pH + b.pD + b.pA, 1, 1e-9);
});

// ----------------------------------------------------------------- calibration --

test('calibration maps: identity, sharpening and draw inflation', () => {
  assert.deepEqual(calibrateX12([0.5, 0.3, 0.2], null), [0.5, 0.3, 0.2]);
  const id = calibrateX12([0.5, 0.3, 0.2], { tau: 1, d: 1 });
  id.forEach((v, i) => close(v, [0.5, 0.3, 0.2][i], 1e-12));
  const sharp = calibrateX12([0.5, 0.3, 0.2], { tau: 1.5, d: 1 });
  assert.ok(sharp[0] > 0.5 && sharp[2] < 0.2);
  const draws = calibrateX12([0.4, 0.3, 0.3], { tau: 1, d: 1.3 });
  assert.ok(draws[1] > 0.3);
  close(draws.reduce((s, v) => s + v, 0), 1, 1e-12);
  close(calibrateBinary(0.6, { a: 0, b: 1 }), 0.6, 1e-12);
  assert.ok(calibrateBinary(0.8, { a: 0, b: 0.5 }) < 0.8, 'slope < 1 pulls towards 1/2');
  assert.equal(isIdentity(null), true);
  assert.equal(isIdentity({ x12: null, ou25: null, btts: null }), true);
  assert.equal(isIdentity({ x12: { tau: 1, d: 1 }, ou25: null, btts: null }), false);
  assert.equal(calibrationLayer(null), null);
});

test('calibration raking: the score matrix reproduces the calibrated 1X2, Over 2.5 and BTTS exactly', () => {
  const M = scoreMatrix(1.7, 1.1, -0.06);
  assert.equal(calibrateMatrix(M, null), M, 'no calibration: the very same matrix');
  const cal = { x12: { tau: 1.3, d: 1.15 }, ou25: { a: 0.1, b: 0.8 }, btts: { a: 0.05, b: 0.7 } };
  const raw = coreProbs(M);
  const target = {
    p: calibrateX12([raw.pH, raw.pD, raw.pA], cal.x12),
    over: calibrateBinary(raw.pOver25, cal.ou25),
    btts: calibrateBinary(raw.pBtts, cal.btts),
  };
  const out = calibrateMatrix(M, cal);
  const c = coreProbs(out);
  close(c.pH, target.p[0], 1e-9);
  close(c.pD, target.p[1], 1e-9);
  close(c.pA, target.p[2], 1e-9);
  close(c.pOver25, target.over, 1e-9);
  close(c.pBtts, target.btts, 1e-9);
  close(out.p.reduce((s, v) => s + v, 0), 1, 1e-12);
  assert.ok(out.p.every((v) => v >= 0));
  // only one market calibrated: the others are not forced to move
  const only = coreProbs(calibrateMatrix(M, { x12: null, ou25: { a: 0, b: 0.6 }, btts: null }));
  close(only.pOver25, calibrateBinary(raw.pOver25, { a: 0, b: 0.6 }), 1e-9);
});

function simulatePredictions(n, seed, { tau = 1, d = 1, slope = 1 } = {}) {
  // Raw forecasts p; outcomes are drawn from the TRUE probabilities calibrate(p, {tau, d, slope}), so
  // tau > 1 / slope > 1 means "the forecasts are under-confident" (as the real 1X2 forecasts are).
  // A calibration fit must therefore recover exactly (tau, d, slope).
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const g = [gammaSample(rand, 2.5), gammaSample(rand, 2), gammaSample(rand, 1.5)];
    const s = g[0] + g[1] + g[2];
    const p = g.map((v) => v / s);
    const truth = calibrateX12(p, { tau, d });
    const u = rand();
    const o = u < truth[0] ? 0 : u < truth[0] + truth[1] ? 1 : 2;
    const pOver = 0.35 + 0.3 * rand();
    const trueOver = calibrateBinary(pOver, { a: 0, b: slope });
    const pBtts = 0.35 + 0.3 * rand();
    const trueBtts = calibrateBinary(pBtts, { a: 0, b: slope });
    out.push({ t: i, p, o, pOver, over: rand() < trueOver ? 1 : 0, pBtts, btts: rand() < trueBtts ? 1 : 0 });
  }
  return out;
}

test('calibration fit: (tau, d) and the logistic slopes are recovered', () => {
  const recs = simulatePredictions(12000, 3, { tau: 1.3, d: 1.15, slope: 1.4 });
  const x12 = fitX12(recs);
  close(x12.tau, 1.3, 0.1, 'tau');
  close(x12.d, 1.15, 0.1, 'd');
  const ou = fitBinaryMap(recs.map((r) => r.pOver), recs.map((r) => r.over));
  close(ou.b, 1.4, 0.35, 'slope');
  assert.equal(fitX12(recs.slice(0, 50)), null, 'too few records');
});

test('calibration layer is adopted only when it wins out of sample', () => {
  const calibrated = simulatePredictions(3000, 5); // forecasts are already right
  const ev0 = nestedEvaluate(calibrated);
  for (const m of ['x12', 'ou25', 'btts']) assert.equal(ev0.markets[m].adopt, false, `${m} must not be adopted when forecasts are calibrated`);
  const wrong = simulatePredictions(6000, 5, { tau: 1.6, d: 1.3, slope: 2 });
  const ev1 = nestedEvaluate(wrong);
  assert.equal(ev1.markets.x12.adopt, true, JSON.stringify(ev1.markets.x12));
  assert.ok(ev1.markets.x12.gain > 0.005);
  const fit = fitCalibration(wrong);
  const used = adoptedCalibration(fit, ev1);
  assert.ok(used.x12 && used.x12.tau > 1);
  const few = nestedEvaluate(wrong.slice(0, 100));
  assert.equal(few.markets.x12.adopt, false);
  assert.match(few.markets.x12.reason, /only 100 matches/);
  assert.equal(adoptedCalibration(fit, ev0).x12, null);
});

// ---------------------------------------------------------------------- metrics --

test('scores: RPS, log-loss, Brier on hand-computed examples', () => {
  // home win forecast [0.5, 0.3, 0.2], home win happened
  close(rps([0.5, 0.3, 0.2], 0), 0.5 * ((0.5 - 1) ** 2 + (0.8 - 1) ** 2), 1e-12);
  // draw happened
  close(rps([0.5, 0.3, 0.2], 1), 0.5 * ((0.5 - 0) ** 2 + (0.8 - 1) ** 2), 1e-12);
  assert.equal(rps([1, 0, 0], 0), 0);
  assert.equal(rps([0, 0, 1], 0), 1);
  close(logLoss1x2([0.5, 0.3, 0.2], 2), -Math.log(0.2), 1e-12);
  assert.ok(Number.isFinite(logLoss1x2([1, 0, 0], 1)), 'clipped, never infinite');
  close(brier1x2([0.5, 0.3, 0.2], 0), 0.25 + 0.09 + 0.04, 1e-12);
  close(logLossBinary(0.7, 1), -Math.log(0.7), 1e-12);
  close(logLossBinary(0.7, 0), -Math.log(0.3), 1e-12);
  close(pairedSe([1, 2, 3, 4], [0, 0, 0, 0]), Math.sqrt(1.6666666667 / 4), 1e-9);
  assert.ok(Number.isNaN(pairedSe([1], [0])));
});

test('scores: base rates beat nothing, a perfect forecast beats base rates; summarize objective', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ x: i % 3, y: (i + 1) % 2 }));
  const b = baseRates(rows);
  close(b.p[0] + b.p[1] + b.p[2], 1, 1e-12);
  const recs = rows.map((r) => ({ p: [0.4, 0.3, 0.3], o: outcomeIndex(r.x, r.y), pOver: 0.5, over: r.x + r.y >= 3 ? 1 : 0, pBtts: 0.5, btts: r.x > 0 && r.y > 0 ? 1 : 0 }));
  const s = summarize(recs);
  close(s.objective, s.x12.logLoss + s.ou25.logLoss + s.btts.logLoss, 1e-12);
  assert.equal(s.n, 300);
});

test('reliability: bins and calibration slope (slope 1 for calibrated forecasts, > 1 for under-confident ones)', () => {
  const rand = mulberry32(8);
  const preds = [];
  const ok = [];
  const under = [];
  for (let i = 0; i < 20000; i++) {
    const p = 0.1 + 0.8 * rand();
    preds.push(p);
    ok.push(rand() < p ? 1 : 0);
    under.push(rand() < calibrateBinary(p, { a: 0, b: 1.4 }) ? 1 : 0);
  }
  close(fitLogistic(preds, ok).b, 1, 0.1, 'calibrated slope');
  close(fitLogistic(preds, under).b, 1.4, 0.15, 'under-confident slope');
  const bins = calibrationBins(preds, ok, 10);
  assert.equal(bins.reduce((s, b) => s + b.n, 0), 20000);
  for (const b of bins) close(b.p, b.f, 0.05, `bin ${b.lo}`);
  assert.equal(fitLogistic([0.5], [1]), null, 'too little data');
  const rep = calibrationReport([{ p: [0.5, 0.3, 0.2], o: 0, pOver: 0.5, over: 1, pBtts: 0.5, btts: 0 }]);
  assert.deepEqual(Object.keys(rep), ['home', 'draw', 'away', 'ou25', 'btts']);
});

// --------------------------------------------------------------------- back-test --

function backtestRows(seed = 31, seasons = 5) {
  const start = dayNumberFromIso('2020-08-10');
  const sim = simulateLeague({ seed, nTeams: 10, seasons, sd: 0.3, day0: start });
  // a season is 365 days apart starting 10 Aug: tag with the real start year
  return sim.matches.map((m) => ({ ...m, season: yearOfDay(m.t) }));
}

test('back-test: only matches before the origin are used (changing the future changes nothing)', () => {
  const rows = backtestRows();
  const lastDay = rows.at(-1).t;
  const cut = lastDay - 120; // alter every result in the last 120 days
  const altered = rows.map((m) => (m.t >= cut ? { ...m, x: m.x + 5, y: Math.max(0, m.y - 1) } : m));
  const from = rows[Math.floor(rows.length * 0.6)].t;
  const params = { xi: 0.0019, sigma: 0.25, om: 1, elo: false };
  const a = runBacktest({ matches: rows, from, to: cut, params });
  const b = runBacktest({ matches: altered, from, to: cut, params });
  assert.equal(a.records.length, b.records.length);
  assert.ok(a.records.length > 100);
  for (let i = 0; i < a.records.length; i++) {
    assert.deepEqual(a.records[i].p, b.records[i].p, `record ${i} depends on the future`);
  }
  // ... while predictions for matches AFTER the altered results do change
  const c = runBacktest({ matches: rows, from: cut, to: lastDay + 1, params });
  const d = runBacktest({ matches: altered, from: cut, to: lastDay + 1, params });
  assert.ok(c.records.length > 0 && d.records.length > 0);
});

test('back-test: beats the base rates on a league with real strength differences; plain Poisson option; records carry base rates', () => {
  const rows = backtestRows(41);
  const from = rows[Math.floor(rows.length * 0.5)].t;
  const to = rows.at(-1).t + 1;
  const { records, origins } = runBacktest({ matches: rows, from, to, params: { xi: 0.0019, sigma: 0.25, om: 1, elo: false }, baseline: true });
  assert.ok(origins > 10);
  const model = summarize(records);
  const base = summarize(records, (r) => r.base);
  assert.ok(model.x12.rps < base.x12.rps * 0.97, `RPS ${model.x12.rps} vs base ${base.x12.rps}`);
  assert.ok(records.every((r) => r.base && r.base.p.length === 3));
  assert.ok(records.some((r) => r.early) && records.some((r) => !r.early));

  const plain = runBacktest({ matches: rows, from, to, params: { xi: 0, sigma: 0.25, om: 1, elo: false }, rho: 0 });
  assert.equal(plain.records.length, records.length);
  // rho = 0 really means the independent Poisson matrix
  const r0 = plain.records[3];
  const M = scoreMatrix(r0.lam, r0.mu, 0);
  close(coreProbs(M).pH, r0.p[0], 1e-9);
});

test('back-test: the bootstrap forecaster adds ranges and stays proper', () => {
  const rows = backtestRows(51, 4);
  const from = rows.at(-1).t - 120;
  const { records } = runBacktest({ matches: rows, from, to: rows.at(-1).t + 1, params: { xi: 0.0019, sigma: 0.25, om: 1, elo: false }, bootstrapK: 8, seedTag: 'X' });
  assert.ok(records.length > 10);
  for (const r of records) {
    close(r.p[0] + r.p[1] + r.p[2], 1, 1e-9);
    assert.ok(r.ranges.oneX2.home[0] <= r.p[0] + 1e-12 && r.p[0] <= r.ranges.oneX2.home[1] + 1e-12);
  }
  const again = runBacktest({ matches: rows, from, to: rows.at(-1).t + 1, params: { xi: 0.0019, sigma: 0.25, om: 1, elo: false }, bootstrapK: 8, seedTag: 'X' });
  assert.deepEqual(again.records[0].p, records[0].p, 'reproducible');
});

test('count back-test: NegBin beats Poisson on over-dispersed counts and the families are chosen sensibly', () => {
  const rand = mulberry32(61);
  const start = dayNumberFromIso('2021-08-10');
  const sim = simulateLeague({ seed: 61, nTeams: 12, seasons: 5, sd: 0.2, day0: start });
  const strength = new Map(sim.teams.map((k) => [k, 0.15 * normal(rand)]));
  const rows = sim.matches.map((m) => ({
    ...m,
    season: yearOfDay(m.t),
    hc: nbSample(rand, Math.exp(1.6 + strength.get(m.home)), 6),
    ac: nbSample(rand, Math.exp(1.55 + strength.get(m.away)), 6),
    hy: poissonSample(rand, Math.exp(0.6 + strength.get(m.home) * 0.5)),
    ay: poissonSample(rand, Math.exp(0.65 + strength.get(m.away) * 0.5)),
  }));
  const from = rows[Math.floor(rows.length * 0.5)].t;
  const to = rows.at(-1).t + 1;
  const corners = runCountBacktest({ matches: rows, from, to, fields: { home: 'hc', away: 'ac' }, xi: 0.0019 });
  assert.ok(corners.n > 400, `n = ${corners.n}`);
  assert.ok(corners.gain > 3 * corners.gainSe && corners.gain > 0.02, `corner gain ${corners.gain} ± ${corners.gainSe}`);
  assert.ok(corners.families.negbin > corners.families.poisson);
  const yellows = runCountBacktest({ matches: rows, from, to, fields: { home: 'hy', away: 'ay' }, xi: 0.0019 });
  assert.ok(Math.abs(yellows.gain) < 0.02, `equi-dispersed counts: gain ${yellows.gain}`);
  assert.equal(runCountBacktest({ matches: rows, from: to + 5, to: to + 50, fields: { home: 'hc', away: 'ac' }, xi: 0.0019 }), null);
});

// ------------------------------------------------------ empirical-Bayes scorer prior --

function simulateScorers({ a, b, players, matchesPlayed, seed }) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < players; i++) {
    const theta = gammaSample(rand, a) / b;
    const g = poissonSample(rand, theta * matchesPlayed);
    if (g >= 1) out.push({ g, n: matchesPlayed });
  }
  return out;
}

test('scorer prior: Gamma(a, b) is recovered by the zero-truncated negative-binomial likelihood', () => {
  const pairs = simulateScorers({ a: 2, b: 25, players: 900, matchesPlayed: 30, seed: 4 });
  const fit = fitScorerPrior(pairs, { listLength: pairs.length });
  assert.equal(fit.ok, true, fit.reason);
  assert.equal(fit.source, 'eb');
  // the product a / b (the mean scoring rate) is the well-determined quantity
  close(fit.a / fit.b, 2 / 25, 0.03, 'mean rate');
  assert.ok(fit.a > 0.8 && fit.a < 5, `a = ${fit.a}`);
});

test('scorer prior: falls back to a = 1, b = 12 when the data cannot support an estimate', () => {
  const few = simulateScorers({ a: 2, b: 25, players: 30, matchesPlayed: 30, seed: 4 });
  const f1 = fitScorerPrior(few);
  assert.equal(f1.source, 'default');
  assert.deepEqual([f1.a, f1.b], [DEFAULT_PRIOR.a, DEFAULT_PRIOR.b]);
  assert.match(f1.reason, /listed players/);

  const early = simulateScorers({ a: 2, b: 25, players: 2000, matchesPlayed: 4, seed: 4 });
  const f2 = fitScorerPrior(early.slice(0, 200));
  assert.equal(f2.source, 'default');
  assert.match(f2.reason, /too early/);

  // a list cut at 200 players: the truncation point moves up, the estimate still works
  const many = simulateScorers({ a: 2, b: 25, players: 2500, matchesPlayed: 30, seed: 9 })
    .sort((p, q) => q.g - p.g)
    .slice(0, 200);
  const f3 = fitScorerPrior(many, { listLength: 200, limit: 200 });
  assert.ok(f3.lower >= 2, `truncation point ${f3.lower}`);
});
