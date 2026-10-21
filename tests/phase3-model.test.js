import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatrix } from '../src/model/poisson.js';
import { goalMarkets } from '../src/model/markets.js';
import {
  refereeTokens, refereeKey, refereeStats, refereeNamesCompatible, refereeEntry, refereeFactor, refereeSummary,
} from '../src/model/counts.js';
import { playerTokens, matchPlayer } from '../src/sources/playerNames.js';
import { teamScorerProbs } from '../src/model/scorers.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------
// Referee names from two sources

test('referee names: tokens, keys and the ", Country" suffix of API-Football', () => {
  assert.deepEqual(refereeTokens('Michael Oliver, England'), ['michael', 'oliver']);
  assert.deepEqual(refereeTokens('M Oliver'), ['m', 'oliver']);
  assert.deepEqual(refereeTokens('M. Oliver'), ['m', 'oliver']);
  assert.deepEqual(refereeTokens('Jesús Gil Manzano, Spain'), ['jesus', 'gil', 'manzano']);
  assert.deepEqual(refereeTokens(null), []);
  assert.equal(refereeKey('M Oliver'), 'm oliver');
  assert.equal(refereeKey('Michael Oliver, England'), 'm oliver'); // the exact key already agrees
  assert.equal(refereeKey('Maresca'), 'maresca');
  assert.equal(refereeKey(''), null);
});

function refHistory() {
  const rows = [];
  const add = (referee, n, cards) => {
    for (let i = 0; i < n; i++) rows.push({ t: 10 + rows.length, referee, hy: cards, ay: 0, hr: 0, ar: 0 });
  };
  add('M Oliver', 10, 5); // 5 cards a match
  add('A Taylor', 8, 3);
  add('P Taylor', 8, 4);
  add('Gil Manzano', 6, 6);
  add('Maresca', 2, 8); // below the 5-match minimum
  add('Other', 40, 3.5);
  return rows;
}

test('referee factor: the same referee in two spellings gives the same factor', () => {
  const stats = refereeStats(refHistory(), 1000);
  const fdOrg = refereeFactor(stats, 'Michael Oliver');
  const apiFootball = refereeFactor(stats, 'Michael Oliver, England');
  assert.ok(fdOrg > 1, 'a strict referee raises the yellow cards');
  near(fdOrg, apiFootball, 1e-12, 'same factor');
  // spec formula f = (S + 10 cbar) / ((n + 10) cbar) with S = 50 cards in n = 10 matches
  near(fdOrg, (50 + 10 * stats.cbar) / (20 * stats.cbar), 1e-12, 'spec formula');
});

test('referee factor: surname-only history names, ambiguity and the 5-match minimum', () => {
  const stats = refereeStats(refHistory(), 1000);
  // history "Gil Manzano" (no first name) <-> API-Football "Jesus Gil Manzano, Spain"
  assert.ok(refereeFactor(stats, 'Jesus Gil Manzano, Spain') > 1);
  // two different Taylors in the history: "Anthony Taylor" must pick A Taylor, "Taylor" alone is ambiguous
  const a = refereeEntry(stats, 'Anthony Taylor, England');
  assert.equal(a.n, 8);
  assert.equal(a.S, 24);
  assert.equal(refereeEntry(stats, 'Paul Taylor, England').S, 32);
  assert.equal(refereeEntry(stats, 'Taylor'), null, 'a bare surname that fits two referees is not guessed');
  assert.equal(refereeFactor(stats, 'Taylor'), 1);
  // a different first initial does not match
  assert.equal(refereeEntry(stats, 'Daniel Oliver, England'), null);
  // fewer than 5 matches: factor 1
  assert.equal(refereeFactor(stats, 'Fabio Maresca, Italy'), 1);
  // unknown referee and missing name
  assert.equal(refereeFactor(stats, 'Nobody Known'), 1);
  assert.equal(refereeFactor(stats, null), 1);
});

test('referee names: compatibility rule', () => {
  const c = (other, hist) => refereeNamesCompatible(refereeTokens(other), refereeTokens(hist));
  assert.equal(c('Michael Oliver', 'M Oliver'), true);
  assert.equal(c('Michael Oliver', 'D Oliver'), false);
  assert.equal(c('Jesus Gil Manzano', 'Gil Manzano'), true);
  assert.equal(c('Jesus Gil Manzano', 'Manzano'), true);
  assert.equal(c('Oliver', 'M Oliver'), false, 'a bare surname carries no initial to compare');
  assert.equal(c('', 'M Oliver'), false);
  assert.equal(c('Michael Oliver', ''), false);
});

test('referee summary for the page', () => {
  const stats = refereeStats(refHistory(), 1000);
  const known = refereeSummary(stats, 'Michael Oliver, England');
  assert.equal(known.name, 'Michael Oliver');
  assert.equal(known.matches, 10);
  assert.ok(known.factor > 1);
  const few = refereeSummary(stats, 'Fabio Maresca, Italy');
  assert.equal(few.matches, 2);
  assert.equal(few.factor, null);
  const unknown = refereeSummary(stats, 'Nobody Known');
  assert.deepEqual({ ...unknown }, { name: 'Nobody Known', matches: 0, factor: null });
  assert.equal(refereeSummary(stats, null), null);
  assert.equal(refereeSummary(stats, '  '), null);
});

// ---------------------------------------------------------------------------
// Player names

test('player names: folding', () => {
  assert.deepEqual(playerTokens('E. Haaland'), ['e', 'haaland']);
  assert.deepEqual(playerTokens('Heung-Min Son'), ['heung', 'min', 'son']);
  assert.deepEqual(playerTokens("N'Golo Kanté"), ['ngolo', 'kante']);
  assert.deepEqual(playerTokens('Martin Ødegaard'), ['martin', 'odegaard']);
  assert.deepEqual(playerTokens('Vinícius Júnior'), ['vinicius', 'junior']);
  assert.deepEqual(playerTokens(undefined), []);
});

test('player names: API-Football abbreviations against football-data.org full names (unique matches only)', () => {
  const squad = [
    { name: 'Erling Haaland' },
    { name: 'Phil Foden' },
    { name: 'Bernardo Silva' },
    { name: 'Rodri' },
    { name: 'Rúben Dias' },
    { name: 'Josko Gvardiol' },
    { name: 'Julian Alvarez' },
    { name: 'Jack Grealish' },
    { name: 'Jérémy Doku' },
    { name: 'Nathan Aké' },
    { name: 'Manuel Akanji' },
  ];
  const find = (n) => matchPlayer(n, squad)?.name ?? null;
  assert.equal(find('E. Haaland'), 'Erling Haaland');
  assert.equal(find('P. Foden'), 'Phil Foden');
  assert.equal(find('Bernardo Silva'), 'Bernardo Silva');
  assert.equal(find('B. Silva'), 'Bernardo Silva');
  assert.equal(find('Rodri'), 'Rodri');
  assert.equal(find('R. Dias'), 'Rúben Dias');
  assert.equal(find('J. Doku'), 'Jérémy Doku');
  assert.equal(find('N. Ake'), 'Nathan Aké');
  assert.equal(find('J. Grealish'), 'Jack Grealish');
  // wrong initial / unknown player
  assert.equal(find('K. Haaland'), null);
  assert.equal(find('Kevin De Bruyne'), null);
  assert.equal(find('M. Akanji'), 'Manuel Akanji');
  assert.equal(find(''), null);
});

test('player names: two candidates are never guessed', () => {
  const squad = [{ name: 'Gabriel Magalhães' }, { name: 'Gabriel Jesus' }, { name: 'Gabriel Martinelli' }, { name: 'Jorginho' }, { name: 'Jurriën Timber' }, { name: 'Jakub Kiwior' }];
  assert.equal(matchPlayer('Gabriel', squad), null);
  assert.equal(matchPlayer('Gabriel Jesus', squad)?.name, 'Gabriel Jesus');
  assert.equal(matchPlayer('G. Jesus', squad)?.name, 'Gabriel Jesus');
  assert.equal(matchPlayer('G. Martinelli', squad)?.name, 'Gabriel Martinelli');
  // "J. ..." with two J-surnames is fine as long as the surname decides
  assert.equal(matchPlayer('J. Timber', squad)?.name, 'Jurriën Timber');
  assert.equal(matchPlayer('J. Kiwior', squad)?.name, 'Jakub Kiwior');
  // the same surname twice in one squad with the same initial is ambiguous
  const twins = [{ name: 'Alex Pereira' }, { name: 'Andre Pereira' }, { name: 'Antonio Pereira' }];
  assert.equal(matchPlayer('A. Pereira', twins), null);
  assert.equal(matchPlayer('Alex Pereira', twins)?.name, 'Alex Pereira');
  assert.equal(matchPlayer('Pereira', twins), null);
});

test('player names: first and last word tier handles a long API spelling', () => {
  const squad = [{ name: 'Bruno Fernandes' }, { name: 'Casemiro' }];
  assert.equal(matchPlayer('Bruno Miguel Borges Fernandes', squad)?.name, 'Bruno Fernandes');
  assert.equal(matchPlayer('Carlos Henrique Casemiro', squad), null);
});

// ---------------------------------------------------------------------------
// Scorers with absences

function scorerFixture(extra = {}) {
  const lam = 1.6;
  const mu = 1.1;
  const m = goalMarkets(scoreMatrix(lam, mu, 0));
  const players = [
    { name: 'Star', G0: 9, G1: 0, sameClub: false },
    { name: 'Second', G0: 5, G1: 0, sameClub: false },
    { name: 'Third', G0: 3, G1: 0, sameClub: false },
    { name: 'Fourth', G0: 1, G1: 0, sameClub: false },
  ];
  return { players, args: { N0: 10, N1: 0, lamT: lam, lamBarT: 1.5, pmfN: m.marginals.home, lam, mu, ...extra } };
}

test('scorers: absent players get zero, doubtful ones only a tag, the others do not change', () => {
  const { players, args } = scorerFixture();
  const base = teamScorerProbs({ players, ...args });
  const flagged = teamScorerProbs({
    players: players.map((p) => (p.name === 'Star' ? { ...p, absent: true, kind: 'injury' } : p.name === 'Second' ? { ...p, doubtful: true, kind: 'injury' } : p)),
    ...args,
  });
  const get = (res, name) => res.players.find((p) => p.name === name);
  assert.equal(get(flagged, 'Star').anytime, 0);
  assert.equal(get(flagged, 'Star').absent, true);
  assert.equal(get(flagged, 'Star').kind, 'injury');
  assert.equal(get(flagged, 'Second').doubtful, true);
  assert.equal(get(flagged, 'Second').absent, false);
  near(get(flagged, 'Second').anytime, get(base, 'Second').anytime, 1e-12, 'doubtful: same probability');
  near(get(flagged, 'Third').anytime, get(base, 'Third').anytime, 1e-12, 'others unchanged (no cap involved)');
  // not flagged -> no absent flag, doubtful false, kind null
  assert.equal(get(base, 'Third').absent, false);
  assert.equal(get(base, 'Third').doubtful, false);
  assert.equal(get(base, 'Third').kind, null);
});

test('scorers: preRank is the rank by scoring rate before the absences', () => {
  const { players, args } = scorerFixture();
  const res = teamScorerProbs({ players: players.map((p) => (p.name === 'Star' ? { ...p, absent: true } : p)), ...args });
  const rank = Object.fromEntries(res.players.map((p) => [p.name, p.preRank]));
  assert.deepEqual(rank, { Star: 0, Second: 1, Third: 2, Fourth: 3 });
  // the displayed order puts the absentee last
  assert.equal(res.players.at(-1).name, 'Star');
});

test('scorers: the cap applies to the remaining players when a star is absent', () => {
  const { players, args } = scorerFixture({ lamBarT: 0.3 }); // tiny lamBarT forces the cap
  const withStar = teamScorerProbs({ players, ...args });
  const without = teamScorerProbs({ players: players.map((p) => (p.name === 'Star' ? { ...p, absent: true } : p)), ...args });
  assert.equal(withStar.capped, true);
  near(without.sumRate, 0.97 * args.lamT, 1e-12, 'capped sum');
  const q = (res, n) => res.players.find((p) => p.name === n).q;
  assert.ok(q(without, 'Second') > q(withStar, 'Second'), 'the remaining players share the freed goals');
});
