import test from 'node:test';
import assert from 'node:assert/strict';
import { makeObjective, packObs } from '../src/model/glm.js';
import { numericGradient } from '../src/model/optimize.js';
import { mulberry32, normal, poissonSample } from './helpers.js';

function buildProblem(family, r) {
  const rand = mulberry32(42);
  const nTeams = 8;
  const rows = [];
  for (let k = 0; k < 160; k++) {
    const h = Math.floor(rand() * nTeams);
    let a = Math.floor(rand() * nTeams);
    if (a === h) a = (a + 1) % nTeams;
    rows.push({
      h,
      a,
      x: family === 'poisson' ? poissonSample(rand, 1.5) + (k % 3 === 0 ? 0.37 : 0) : poissonSample(rand, 5),
      y: family === 'poisson' ? poissonSample(rand, 1.1) : poissonSample(rand, 4),
      w: 0.3 + rand(),
    });
  }
  const obs = packObs(rows);
  const mAtt = Float64Array.from({ length: nTeams }, () => 0.1 * normal(rand));
  const mDef = Float64Array.from({ length: nTeams }, () => 0.1 * normal(rand));
  const objective = makeObjective({ ...obs, nTeams, sigma: 0.25, mAtt, mDef, family, r });
  const theta = Float64Array.from({ length: objective.dim }, (_, i) => (i === 0 ? 0.3 : 0.15 * normal(rand)));
  return { objective, theta };
}

function maxRelErr(analytic, numeric) {
  let worst = 0;
  for (let i = 0; i < analytic.length; i++) {
    const e = Math.abs(analytic[i] - numeric[i]) / Math.max(1, Math.abs(analytic[i]), Math.abs(numeric[i]));
    if (e > worst) worst = e;
  }
  return worst;
}

for (const [family, r] of [['poisson', Infinity], ['negbin', 12]]) {
  test(`Test 4: analytic gradient equals numeric gradient (${family})`, () => {
    const { objective, theta } = buildProblem(family, r);
    const { g } = objective.derivs(theta);
    const num = numericGradient((t) => objective.value(t), theta, 1e-6);
    const err = maxRelErr(g, num);
    assert.ok(err < 1e-5, `relative error ${err}`);
  });
}

test('Poisson information matrix equals the numeric Hessian of the objective', () => {
  const { objective, theta } = buildProblem('poisson', Infinity);
  const { H } = objective.derivs(theta);
  const n = theta.length;
  let worst = 0;
  for (let j = 0; j < n; j++) {
    const tp = Float64Array.from(theta);
    const tm = Float64Array.from(theta);
    tp[j] += 1e-5;
    tm[j] -= 1e-5;
    const gp = objective.derivs(tp).g;
    const gm = objective.derivs(tm).g;
    for (let i = 0; i < n; i++) {
      const numeric = -(gp[i] - gm[i]) / 2e-5; // information = minus Hessian
      const e = Math.abs(H[i * n + j] - numeric) / Math.max(1, Math.abs(numeric));
      if (e > worst) worst = e;
    }
  }
  assert.ok(worst < 1e-5, `relative error ${worst}`);
});
