import test from 'node:test';
import assert from 'node:assert/strict';
import { fitGoals, fitRho } from '../src/model/dc.js';
import { fitCountMarket } from '../src/model/counts.js';
import { simulateLeague } from './helpers.js';

test('Test 8: the model for date t ignores every match dated >= t', () => {
  const { teams, matches } = simulateLeague({ seed: 21, seasons: 2 });
  const t = 500;
  const past = matches.filter((m) => m.t < t);
  assert.ok(past.length > 200 && past.length < matches.length);

  // Poison every match dated >= t with absurd values, including exactly t.
  const poisoned = matches.map((m) => (m.t >= t ? { ...m, x: 40, y: 40, hc: 99, ac: 99 } : m));

  const clean = fitGoals({ matches: past, teams, tNow: t, xi: 0.0019 });
  const dirty = fitGoals({ matches: poisoned, teams, tNow: t, xi: 0.0019 });

  assert.equal(clean.nUsed, dirty.nUsed);
  assert.equal(clean.c, dirty.c);
  assert.equal(clean.eta, dirty.eta);
  for (let i = 0; i < teams.length; i++) {
    assert.equal(clean.att[i], dirty.att[i]);
    assert.equal(clean.def[i], dirty.def[i]);
  }
  assert.equal(fitRho(clean).rho, fitRho(dirty).rho);
  assert.ok(dirty.used.every((m) => m.t < t));
});

test('Test 8b: count models also ignore matches dated >= t', () => {
  const { teams, matches } = simulateLeague({ seed: 22, seasons: 2 });
  const withCorners = matches.map((m, i) => ({ ...m, hc: 3 + (i % 7), ac: 2 + (i % 5) }));
  const t = 520;
  const clean = fitCountMarket({
    matches: withCorners.filter((m) => m.t < t),
    teams,
    homeField: 'hc',
    awayField: 'ac',
    tNow: t,
    xi: 0.0019,
  });
  const dirty = fitCountMarket({
    matches: withCorners.map((m) => (m.t >= t ? { ...m, hc: 99, ac: 99 } : m)),
    teams,
    homeField: 'hc',
    awayField: 'ac',
    tNow: t,
    xi: 0.0019,
  });
  assert.equal(clean.nUsed, dirty.nUsed);
  for (let i = 0; i < teams.length; i++) assert.equal(clean.fit.att[i], dirty.fit.att[i]);
});
