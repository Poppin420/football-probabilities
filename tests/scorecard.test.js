import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScorecard, predictionOf, statsOf, updateScorecard } from '../src/pipeline/scorecard.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const resolver = { key: (n) => String(n ?? '').toLowerCase() };
const match = (over = {}) => ({
  id: 1,
  kickoff: '2026-10-21T19:00:00Z',
  home: 'arsenal',
  away: 'chelsea',
  homeName: 'Arsenal',
  awayName: 'Chelsea',
  goals: { oneX2: { home: 0.5, draw: 0.3, away: 0.2 }, totals: [{ line: 2.5, over: 0.55, under: 0.45 }], btts: { yes: 0.6, no: 0.4 } },
  corners: { mean: { total: 10.2 } },
  cards: { mean: { total: 4.1 } },
  ...over,
});
const empty = () => ({ domestic: new Map(), cups: new Map() });

test('prediction: the published numbers are copied, a match without 1X2 gives nothing', () => {
  const p = predictionOf('PL', match(), NOW);
  assert.deepEqual([p.k, p.p, p.ou25, p.btts, p.cm, p.kd], ['PL:1', [0.5, 0.3, 0.2], 0.55, 0.6, 10.2, 4.1]);
  assert.equal(predictionOf('PL', match({ goals: {} }), NOW), null);
});

test('forecast of a match not started yet is stored (the latest wins); a started match is scored once its result is there', () => {
  let { store } = updateScorecard({ prev: null, built: [{ code: 'PL', json: { matches: [match()] } }], results: empty(), resolver, now: NOW });
  assert.equal(Object.keys(store.open).length, 1);
  const later = new Date('2026-10-21T09:00:00Z');
  ({ store } = updateScorecard({ prev: store, built: [{ code: 'PL', json: { matches: [match({ goals: { oneX2: { home: 0.6, draw: 0.25, away: 0.15 }, totals: [], btts: { yes: 0.5 } } })] } }], results: empty(), resolver, now: later }));
  assert.deepEqual(store.open['PL:1'].p, [0.6, 0.25, 0.15]);

  // after the match, no result yet: still waiting
  const after = new Date('2026-10-22T09:00:00Z');
  let r = updateScorecard({ prev: store, built: [], results: empty(), resolver, now: after });
  assert.equal(r.scorecard.scored, 0);
  assert.equal(r.scorecard.pending, 1);
  // the CSV row of the day before / after is accepted, goals decide the outcome, corners and cards are compared
  const results = empty();
  results.domestic.set('PL', [{ t: Math.floor(Date.parse('2026-10-21T00:00:00Z') / 86400000), home: 'arsenal', away: 'chelsea', x: 2, y: 2, hc: 6, ac: 5, hy: 2, ay: 1, hr: 0, ar: 1 }]);
  r = updateScorecard({ prev: store, built: [], results, resolver, now: after });
  assert.equal(r.scorecard.scored, 1);
  assert.equal(r.scorecard.pending, 0);
  const s = r.scorecard.leagues.PL;
  assert.equal(s.hit, 0); // the draw was not the favourite
  assert.ok(Math.abs(s.rps - (0.5 * (0.6 ** 2 + (0.85 - 1) ** 2))) < 1e-9);
  assert.equal(s.skill, null, 'one match: no skill is claimed');
  assert.deepEqual([s.corners.mae, s.corners.n], [Math.abs(10.2 - 11), 1]);
  assert.equal(s.cards.meanActual, 4);
  assert.equal(s.btts.n, 1);
  // scored twice is still one match
  const again = updateScorecard({ prev: r.store, built: [], results, resolver, now: after });
  assert.equal(again.scorecard.scored, 1);
});

test('cups are matched by id; a result that never arrives is dropped after 10 days and counted as lost', () => {
  const m = match({ id: 77, corners: undefined, cards: undefined });
  let { store } = updateScorecard({ prev: null, built: [{ code: 'CL', json: { matches: [m] } }], results: empty(), resolver, now: NOW });
  const results = empty();
  results.cups.set('CL', [{ id: 77, kickoff: m.kickoff, home: { name: 'Arsenal' }, away: { name: 'Chelsea' }, x: 1, y: 0 }]);
  const day = new Date('2026-10-22T00:00:00Z');
  const ok = updateScorecard({ prev: store, built: [], results, resolver, now: day });
  assert.equal(ok.scorecard.leagues.CL.n, 1);
  assert.equal(ok.scorecard.domestic, null);
  const lost = updateScorecard({ prev: store, built: [], results: empty(), resolver, now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(lost.scorecard.lost, 1);
  assert.equal(lost.scorecard.pending, 0);
});

test('stats: skill needs 20 matches, base rates come from the sample, calibration bins add up', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ k: `x${i}`, code: 'PL', kickoff: '2026-10-01T00:00:00Z', p: [0.6, 0.25, 0.15], o: i % 5 === 0 ? 1 : i % 5 === 1 ? 2 : 0, goals: 3, ou25: 0.5, btts: 0.5, both: 1 });
  const s = statsOf(rows);
  assert.equal(s.n, 30);
  assert.ok(s.skill !== null && Number.isFinite(s.skill));
  assert.equal(s.calibration.reduce((a, b) => a + b.n, 0), 90);
  assert.ok(Math.abs(s.outcomes.home + s.outcomes.draw + s.outcomes.away - 1) < 1e-12);
  assert.equal(statsOf([]), null);
  assert.equal(buildScorecard({ open: {}, done: [] }, { now: NOW }).all, null);
});
