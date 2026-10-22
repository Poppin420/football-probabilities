import test from 'node:test';
import assert from 'node:assert/strict';
import { createEuroCounts } from '../src/model/euroCounts.js';

function model({ c, eta, att, def, r = 20, teams, effN = 50 }) {
  const index = new Map(teams.map((t, i) => [t, i]));
  return { index, fit: { c, eta, att, def }, family: 'negbin', r, effN: teams.map(() => effN) };
}
const red = (teams, rbar) => ({ index: new Map(teams.map((t, i) => [t, i])), rbar, mult: teams.map(() => 1) });

const A = ['a1', 'a2'];
const B = ['b1', 'b2'];
const models = [
  { code: 'X', corners: model({ c: 1.2, eta: 0.1, att: [0.1, -0.1], def: [0.05, -0.05], teams: A }), yellow: model({ c: 0.6, eta: 0.05, att: [0.1, -0.1], def: [0, 0], teams: A }), red: red(A, 0.05) },
  { code: 'Y', corners: model({ c: 1.4, eta: 0.3, att: [0, 0.2], def: [0.1, 0], teams: B, r: 10 }), yellow: model({ c: 0.8, eta: 0.15, att: [0, 0], def: [0, 0], teams: B }), red: red(B, 0.15) },
];

test('euro counts: means from the two own leagues, cross-league formula', () => {
  const e = createEuroCounts(models);
  const c = e.corners('a1', 'b2');
  const co = (1.2 + 1.4) / 2;
  const eta = (0.1 + 0.3) / 2;
  assert.ok(Math.abs(c.mean.home - Math.exp(co + eta + 0.1 + 0)) < 0.02, String(c.mean.home));
  assert.ok(Math.abs(c.mean.away - Math.exp(co + 0.2 + 0.05)) < 0.02, String(c.mean.away));
  assert.equal(c.estimate, true);
  assert.deepEqual(c.basis, ['X', 'Y']);
});

test('euro counts: neutral ground removes the home advantage', () => {
  const e = createEuroCounts(models);
  const n = e.corners('a1', 'b2', { neutral: true });
  assert.ok(Math.abs(n.mean.home - Math.exp((1.2 + 1.4) / 2 + 0.1)) < 0.02);
});

test('euro counts: cards use the mean red rate, unknown / thin clubs give null', () => {
  const e = createEuroCounts(models);
  const k = e.cards('a1', 'b1');
  assert.equal(k.estimate, true);
  assert.equal(k.refereeFactor, null);
  assert.ok(Math.abs(k.mean.redHome + k.mean.redAway - 2 * 0.1) < 0.01, String(k.mean.redHome + k.mean.redAway));
  assert.equal(e.corners('a1', 'nobody'), null);
  assert.equal(e.cards('nobody', 'b1'), null);
  const thin = createEuroCounts([{ ...models[0], corners: model({ c: 1, eta: 0, att: [0, 0], def: [0, 0], teams: A, effN: 2 }) }, models[1]]);
  assert.equal(thin.corners('a1', 'b1'), null);
  assert.equal(createEuroCounts([]).corners('a1', 'b1'), null);
});

import { createResolver } from '../src/sources/names.js';

test('name matching: a much longer name is not a fuzzy match of a short one (Lillestrom is not Lille)', () => {
  const r = createResolver({});
  const universe = new Set([r.key('Lille'), r.key('Lyon')]);
  assert.equal(r.match('Lillestrom', universe).key, null);
  assert.equal(r.match('Lille', universe).key, r.key('Lille'));
});
