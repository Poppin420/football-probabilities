import test from 'node:test';
import assert from 'node:assert/strict';
import { ELO, compareRatings, expectedScore, goalMultiplier, runOwnElo } from '../src/model/ownElo.js';

const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const m = (iso, home, away, x, y, extra = {}) => ({ t: day(iso), home, away, x, y, group: 'E0', country: 'ENG', level: 1, ...extra });

test('goal-difference multiplier G: 1, 1.5, (11+N)/8', () => {
  assert.equal(goalMultiplier(0), 1);
  assert.equal(goalMultiplier(1), 1);
  assert.equal(goalMultiplier(-1), 1);
  assert.equal(goalMultiplier(2), 1.5);
  assert.equal(goalMultiplier(-2), 1.5);
  assert.equal(goalMultiplier(3), 14 / 8);
  assert.equal(goalMultiplier(5), 2);
});

test('expected score: 0.5 for equal clubs on neutral ground, home advantage 100 points', () => {
  assert.equal(expectedScore(0, 0), 0.5);
  assert.ok(Math.abs(expectedScore(0, 100) - 1 / (1 + 10 ** (-100 / 400))) < 1e-12);
  assert.ok(expectedScore(0, 100) > 0.63 && expectedScore(0, 100) < 0.65);
  assert.ok(Math.abs(expectedScore(200, 0) + expectedScore(-200, 0) - 1) < 1e-12);
});

test('one match: R\' = R + K*G*(W-We), zero-sum, rounded in the snapshot', () => {
  const r = runOwnElo({ matches: [m('2024-08-17', 'a', 'b', 3, 0)], tNow: day('2024-08-18') });
  const we = expectedScore(0, 100);
  const d = ELO.K * (14 / 8) * (1 - we);
  const a = r.current.find((c) => c.club === 'a');
  const b = r.current.find((c) => c.club === 'b');
  assert.ok(Math.abs(a.elo - (1500 + d)) < 0.06);
  assert.ok(Math.abs(b.elo - (1500 - d)) < 0.06);
  assert.equal(a.n, 1);
  assert.equal(a.country, 'ENG');
  assert.equal(a.level, 1);
});

test('a draw between equal clubs moves the HOME side down (it was favoured by 100 points)', () => {
  const r = runOwnElo({ matches: [m('2024-08-17', 'a', 'b', 1, 1)] });
  assert.ok(r.current.find((c) => c.club === 'a').elo < 1500);
  assert.ok(r.current.find((c) => c.club === 'b').elo > 1500);
});

test('neutral ground: no home advantage, a draw changes nothing', () => {
  const r = runOwnElo({ matches: [m('2025-05-31', 'a', 'b', 1, 1, { group: 'CL', neutral: true })] });
  assert.equal(r.current.find((c) => c.club === 'a').elo, 1500);
});

test('matches are processed in date order whatever the input order; missing scores are skipped', () => {
  const list = [m('2024-09-01', 'a', 'c', 2, 0), m('2024-08-17', 'a', 'b', 1, 0), m('2024-08-24', 'b', 'c', null, null)];
  const x = runOwnElo({ matches: list });
  const y = runOwnElo({ matches: [...list].reverse() });
  assert.deepEqual(x.current, y.current);
  assert.equal(x.matches, 2);
});

test('snapshots hold the ratings from matches strictly before the date', () => {
  const list = [m('2024-08-17', 'a', 'b', 2, 0), m('2024-09-01', 'a', 'b', 2, 0), m('2024-09-20', 'a', 'b', 2, 0)];
  const r = runOwnElo({ matches: list, snapshotDates: ['2024-08-17', '2024-09-01', '2024-10-01'], tNow: day('2024-10-05') });
  assert.equal(r.snapshots.get('2024-08-17').length, 0); // nothing before the first match day
  const s1 = r.snapshots.get('2024-09-01');
  const s2 = r.snapshots.get('2024-10-01');
  const a1 = s1.find((c) => c.club === 'a');
  const a2 = s2.find((c) => c.club === 'a');
  assert.equal(a1.n, 1);
  assert.equal(a2.n, 3);
  assert.ok(a2.elo > a1.elo);
});

function league(group, country, names, start, rounds = 2) {
  // double round robin, one round per week
  const out = [];
  let t = day(start);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        out.push({ t: t + ((i * names.length + j) % 300), home: names[i], away: names[j], x: (i + j) % 3, y: (i * j) % 2, group, country, level: 1 });
      }
    }
    t += 400;
  }
  return out;
}

test('newcomers: the first clubs of a league start at 1500, a later newcomer at (league mean - 100)', () => {
  const names = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const base = league('E0', 'ENG', names, '2022-08-01', 1);
  const late = [m('2023-10-01', 'c0', 'new', 1, 1)];
  const r = runOwnElo({ matches: [...base, ...late], tNow: day('2023-10-02') });
  const fresh = r.current.filter((c) => names.includes(c.club));
  const mean = fresh.reduce((s, c) => s + c.elo, 0) / fresh.length;
  const nw = r.current.find((c) => c.club === 'new');
  assert.ok(Math.abs(nw.elo - (mean - 100)) < 60, `new ${nw.elo} vs mean ${mean}`);
  // inside the first 40 days every club starts at exactly 1500
  const early = runOwnElo({ matches: [m('2022-08-01', 'p', 'q', 0, 0), m('2022-08-10', 'r', 's', 0, 0)] });
  assert.ok(Math.abs(early.current.find((c) => c.club === 'r').elo - 1500) < 25); // a 0-0 draw moves a pair by <= 20*0.14
});

test('a club that only plays in the Champions League starts at (mean of all clubs - 100) once there are enough clubs', () => {
  const names = Array.from({ length: 12 }, (_, i) => `d${i}`);
  const base = league('E0', 'ENG', names, '2022-08-01', 1);
  const cl = [{ t: day('2023-09-20'), home: 'd0', away: 'outsider', x: 1, y: 1, group: 'CL' }];
  const r = runOwnElo({ matches: [...base, ...cl], tNow: day('2023-09-21') });
  const out = r.current.find((c) => c.club === 'outsider');
  assert.equal(out.country, null);
  assert.equal(out.level, null);
  assert.ok(out.elo < 1450, `outsider ${out.elo}`);
});

test('countries are linked only through Champions League matches', () => {
  const eng = Array.from({ length: 10 }, (_, i) => `e${i}`);
  const ger = Array.from({ length: 10 }, (_, i) => `g${i}`);
  const list = [...league('E0', 'ENG', eng, '2022-08-01', 1), ...league('D1', 'GER', ger, '2022-08-01', 1)];
  // every English club beats a German one 3-0 in the CL, repeatedly
  for (let k = 0; k < 10; k++) {
    for (let i = 0; i < 10; i++) list.push({ t: day('2023-09-01') + k * 7 + i, home: eng[i], away: ger[i], x: 3, y: 0, group: 'CL' });
  }
  const r = runOwnElo({ matches: list });
  const avg = (names) => names.reduce((s, n) => s + r.current.find((c) => c.club === n).elo, 0) / names.length;
  assert.ok(avg(eng) - avg(ger) > 80, `${avg(eng)} vs ${avg(ger)}`);
});

test('clubs that have not played for more than 400 days drop out of the snapshots', () => {
  const r = runOwnElo({ matches: [m('2020-08-17', 'a', 'b', 1, 0), m('2024-08-17', 'c', 'd', 1, 0)], tNow: day('2024-08-18') });
  assert.deepEqual(r.current.map((c) => c.club).sort(), ['c', 'd']);
});

test('compareRatings: correlation and centred mean absolute difference, offset removed', () => {
  const ours = new Map();
  const theirs = new Map();
  for (let i = 0; i < 30; i++) {
    ours.set(`k${i}`, 1500 + i * 10);
    theirs.set(`k${i}`, 1700 + i * 10 + (i % 2 ? 5 : -5));
  }
  theirs.set('only-them', 1600);
  const c = compareRatings(ours, theirs);
  assert.equal(c.n, 30);
  assert.ok(c.correlation > 0.99);
  assert.ok(Math.abs(c.meanAbsDiff - 5) < 0.5);
  assert.ok(Math.abs(c.offset + 200) < 1);
  assert.equal(compareRatings(new Map([['a', 1]]), new Map([['a', 2]])).correlation, null);
});
