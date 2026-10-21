import test from 'node:test';
import assert from 'node:assert/strict';
import { fitGoals } from '../src/model/dc.js';
import { simulateLeague, corr } from './helpers.js';

// Simulated data are stationary, so the recovery test uses xi = 0 (no time
// decay): it checks the estimator, not the weighting scheme.
for (const seed of [11, 12, 13]) {
  test(`Test 5: simulation recovery, 2 seasons x 20 teams (seed ${seed})`, () => {
    const { teams, truth, matches, lastDay } = simulateLeague({
      seed,
      nTeams: 20,
      seasons: 2,
      sd: 0.25,
      eta: 0.25,
    });
    assert.equal(matches.length, 2 * 380);
    const model = fitGoals({ matches, teams, tNow: lastDay + 1, xi: 0, sigma: 0.25 });

    const cAtt = corr(Array.from(model.att), truth.att);
    const cDef = corr(Array.from(model.def), truth.def);
    assert.ok(cAtt > 0.85, `corr(att) = ${cAtt}`);
    assert.ok(cDef > 0.85, `corr(def) = ${cDef}`);
    assert.ok(Math.abs(model.eta - truth.eta) < 0.12, `eta = ${model.eta}`);
    assert.ok(model.converged, 'Newton iteration converged');

    // The penalised log-likelihood never decreases across iterations.
    for (let i = 1; i < model.trace.length; i++) {
      assert.ok(model.trace[i] >= model.trace[i - 1] - 1e-9, `trace decreased at iteration ${i}`);
    }
    assert.ok(model.trace.length >= 3);
  });
}

test('Weights: a recent block dominates old data when xi is large', () => {
  const { teams, matches, lastDay } = simulateLeague({ seed: 3, seasons: 2 });
  const a = fitGoals({ matches, teams, tNow: lastDay + 1, xi: 0.0019 });
  const b = fitGoals({ matches, teams, tNow: lastDay + 1, xi: 0.02 });
  assert.ok(b.wSum < a.wSum);
});
