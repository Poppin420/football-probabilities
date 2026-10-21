// Phase 3: the proxy back-test of the Elo-only model (the Champions League formula, tested on domestic matches),
// its report block and the warning for a model that is no better than the base rates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BIG_GAP, matchKey, runEloOnlyBacktest, skipReasonText, summarizeFits } from '../src/pipeline/eloOnlyBacktest.js';
import { MIN_ELO_ONLY_MATCHES, eloOnlyFlags, eloOnlyReport } from '../src/pipeline/tune.js';
import { asLeagueRecords, buildEloOnlyWorld, dayOf } from './elo-only-world.js';

const buildWorld = buildEloOnlyWorld;

const world = buildWorld();
const base = runEloOnlyBacktest({ domestic: world.domestic, from: world.from, to: world.to });
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('proxy back-test: the regression finds the true slope again and the forecasts beat the pooled base rates', () => {
  assert.ok(base.records.length > 1200, `${base.records.length} scored matches`);
  assert.ok(base.skipped.origins > 0, 'the first weeks of the window have too few rated matches in the training sample');
  assert.equal(base.fits.length + base.skipped.origins, base.origins);
  assert.equal(base.unrated, 0);
  const s = summarizeFits(base.fits);
  assert.ok(Math.abs(s.kappa.mean - 0.8) < 0.1, `kappa ${s.kappa.mean}`);
  assert.ok(Math.abs(s.eta.mean - 0.25) < 0.06, `eta ${s.eta.mean}`);
  assert.ok(Math.abs(s.c.mean - 0.15) < 0.06, `c ${s.c.mean}`);
  assert.ok(s.kappa.min >= 0.2 && s.kappa.max <= 2, 'every accepted fit is inside the plausible range');
  assert.ok(s.rows.min >= 1500, `every fit used at least the production minimum of rated matches (${s.rows.min})`);

  // RPS of the model and of the base rates computed here, independently of the code under test
  const rps = (p, o) => 0.5 * ((p[0] - (o === 0 ? 1 : 0)) ** 2 + (p[0] + p[1] - (o === 0 ? 1 : o === 1 ? 1 : 0)) ** 2);
  const model = mean(base.records.map((r) => rps(r.p, r.o)));
  const ref = mean(base.records.map((r) => rps(r.base.p, r.o)));
  assert.ok(1 - model / ref > 0.04, `RPS ${model} vs base ${ref}`);

  // calibration at the level of the whole sample
  assert.ok(Math.abs(mean(base.records.map((r) => r.p[0])) - mean(base.records.map((r) => (r.o === 0 ? 1 : 0)))) < 0.03);
  assert.ok(Math.abs(mean(base.records.map((r) => r.pOver)) - mean(base.records.map((r) => r.over))) < 0.03);
  for (const r of base.records) {
    assert.ok(Math.abs(r.p[0] + r.p[1] + r.p[2] - 1) < 1e-9);
    assert.ok(r.lam > 0 && r.mu > 0 && Number.isFinite(r.dE));
    assert.equal(r.key, matchKey(r.t, ...r.key.split('|').slice(1)));
  }
});

test('proxy back-test: no leakage - changing matches from day D on changes no forecast made before D', () => {
  const D = dayOf('2025-12-01');
  // flip every result from D on (the home team now scores 3 more goals) and run again
  const flipped = world.domestic.map((lg) => ({ ...lg, history: lg.history.map((m) => (m.t >= D ? { ...m, x: m.x + 3 } : m)) }));
  const again = runEloOnlyBacktest({ domestic: flipped, from: world.from, to: world.to });
  const before = (res) => res.records.filter((r) => r.t < D);
  assert.ok(before(base).length > 800);
  assert.deepEqual(before(again), before(base), 'identical forecasts for every match before D');
  const after = (res) => res.records.filter((r) => r.t >= D);
  assert.equal(after(again).length, after(base).length);
  assert.notDeepEqual(after(again).map((r) => r.o), after(base).map((r) => r.o), 'the change did reach the later outcomes');
  assert.notDeepEqual(after(again).map((r) => r.p[0]), after(base).map((r) => r.p[0]), 'and the later forecasts, which are trained on them');
});

test('proxy back-test: a sample that is too small, or a slope outside the plausible range, skips the origin and says why', () => {
  const tiny = runEloOnlyBacktest({ domestic: world.domestic, from: world.from, to: world.to, minRows: 10 ** 9 });
  assert.equal(tiny.records.length, 0);
  assert.equal(tiny.skipped.origins, tiny.origins);
  const [key] = Object.keys(tiny.skipped.reasons);
  assert.equal(key, 'only # matches with an Elo rating for both teams (need #)', 'numbers are grouped');
  assert.match(skipReasonText(key), /aliases\.json/);

  // the ratings carry no information about the goals: the slope comes out near 0, below the guard of 0.2
  const flat = buildWorld({ seed: 9, kappa: 0 });
  const res = runEloOnlyBacktest({ domestic: flat.domestic, from: flat.from, to: flat.to });
  assert.equal(res.records.length, 0, 'nothing is forecast with a slope that cannot be right');
  // the first weeks have too few rated matches, all the others fail the guard
  const reasons = res.skipped.reasons;
  assert.ok(reasons['implausible Elo slope kappa = # (expected #-#)'] > 20, JSON.stringify(reasons));
  assert.deepEqual(Object.keys(reasons).filter((k) => !/^(only|implausible)/.test(k)), []);
  assert.match(skipReasonText('implausible Elo slope kappa = # (expected #-#)'), /εκτός λογικών ορίων/);
  assert.equal(skipReasonText('something new'), 'something new');
});

test('proxy back-test: a team without a rating is counted, never guessed', () => {
  const victim = world.domestic[0].history[0].home;
  const without = world.domestic.map((lg) => ({
    ...lg,
    eloAt: (day) => {
      const m = lg.eloAt(day);
      if (!m) return m;
      const copy = new Map(m);
      copy.delete(victim);
      return copy;
    },
  }));
  const res = runEloOnlyBacktest({ domestic: without, from: world.from, to: world.to });
  assert.ok(res.unrated > 0);
  assert.ok(res.records.every((r) => !r.key.split('|').slice(1).includes(victim)));
  assert.ok(res.records.length < base.records.length);
  // matches with a non-integer or missing score are not forecast either
  const broken = world.domestic.map((lg) => ({ ...lg, history: lg.history.map((m, i) => (i % 2 === 0 ? { ...m, x: null } : m)) }));
  const half = runEloOnlyBacktest({ domestic: broken, from: world.from, to: world.to });
  assert.ok(half.records.length < base.records.length * 0.7);
});

test('proxy back-test: the window can be moved and the empty cases do not crash', () => {
  assert.equal(runEloOnlyBacktest({ domestic: [], from: 100, to: 200 }).records.length, 0);
  assert.equal(runEloOnlyBacktest({ domestic: world.domestic, from: world.to, to: world.to }).origins, 0);
  const none = summarizeFits([]);
  assert.equal(none.origins, 0);
  assert.equal(none.kappa, null);
  // a shorter window = a subset of the same forecasts (every origin depends on the past only)
  const late = runEloOnlyBacktest({ domestic: world.domestic, from: dayOf('2025-09-01'), to: world.to });
  const byKey = new Map(base.records.map((r) => [r.key, r]));
  assert.ok(late.records.length > 500);
  for (const r of late.records.slice(0, 200)) assert.equal(byKey.get(r.key)?.t, r.t);
});

// ---------------------------------------------------------------------- the report --

test('report: Elo-only against the pooled base rates and, on the same matches, against the league model', () => {
  const rep = eloOnlyReport({ proxy: base, fullRecords: asLeagueRecords(base.records), leagues: ['AAA', 'BBB', 'CCC'] });
  if (process.env.FP_DEBUG) console.log(JSON.stringify(rep));
  assert.equal(rep.n, base.records.length);
  assert.equal(rep.scored, base.records.length);
  assert.deepEqual(rep.leagues, ['AAA', 'BBB', 'CCC']);
  assert.equal(rep.origins, base.origins);
  assert.equal(rep.skippedOrigins, base.skipped.origins);
  for (const k of ['x12', 'ou25', 'btts']) assert.ok(rep.metrics.model[k] && rep.metrics.base[k], k);
  assert.ok(rep.metrics.model.x12.rps < rep.metrics.base.x12.rps);
  assert.ok(rep.skill.vsBase.rps > 0.04, `skill ${rep.skill.vsBase.rps}`);
  assert.ok(rep.skill.vsBase.logLoss1x2 > 0);
  assert.ok(Math.abs(rep.fit.kappa.mean - 0.8) < 0.1 && rep.fit.kappa.min <= rep.fit.kappa.mean && rep.fit.kappa.mean <= rep.fit.kappa.max);
  assert.equal(rep.fit.origins, base.fits.length);
  assert.deepEqual(rep.flags, []);
  // the "league model" here is a copy of the forecasts themselves: identical scores, zero difference
  assert.ok(rep.leagueModel);
  assert.deepEqual(rep.leagueModel.metrics, rep.metrics.model);
  assert.ok(Math.abs(rep.skill.vsLeagueModel.rps) < 1e-9);
  // the large-gap subset: rating gaps of 200 points and more are common in this world
  assert.equal(rep.bigGap.threshold, BIG_GAP);
  const bigN = base.records.filter((r) => Math.abs(r.dE) >= BIG_GAP).length;
  assert.equal(rep.bigGap.n, bigN);
  assert.ok(rep.bigGap.n >= 100 && rep.bigGap.share > 0.05 && rep.bigGap.share < 1);
  assert.ok(rep.bigGap.skill.vsBase.rps > rep.skill.vsBase.rps, 'the stronger the gap, the more the ratings tell');
  // plain JSON, nothing else (it is written to report.json)
  assert.deepEqual(JSON.parse(JSON.stringify(rep)), rep);
});

test('report: a league model that scored only part of the matches is not compared; the numbers use all scored matches', () => {
  const some = asLeagueRecords(base.records).filter((_, i) => i % 2 === 0);
  const rep = eloOnlyReport({ proxy: base, fullRecords: some, leagues: ['AAA'] });
  assert.equal(rep.leagueModel, null);
  assert.equal(rep.skill.vsLeagueModel, undefined);
  assert.equal(rep.n, base.records.length);
  // 95 % covered: compared on the matches both scored
  const most = asLeagueRecords(base.records).filter((_, i) => i % 20 !== 0);
  const rep2 = eloOnlyReport({ proxy: base, fullRecords: most, leagues: ['AAA'] });
  assert.ok(rep2.leagueModel);
  assert.equal(rep2.n, most.length);
  assert.equal(rep2.scored, base.records.length);
  assert.equal(eloOnlyReport({ proxy: base }).leagueModel, null, 'no league records at all');
});

test('report: too few scored matches = "skipped" with the reason in Greek, not a number', () => {
  const few = { ...base, records: base.records.slice(0, MIN_ELO_ONLY_MATCHES - 1) };
  const rep = eloOnlyReport({ proxy: few, fullRecords: [], leagues: [] });
  assert.match(rep.skipped, new RegExp(`^βαθμολογήθηκαν μόνο ${MIN_ELO_ONLY_MATCHES - 1} αγώνες \\(χρειάζονται ${MIN_ELO_ONLY_MATCHES}\\)`));
  assert.match(rep.skipped, /εβδομαδιαίες αφετηρίες παραλείφθηκαν/);
  assert.equal(rep.metrics, undefined);
  const tiny = runEloOnlyBacktest({ domestic: world.domestic, from: world.from, to: world.to, minRows: 10 ** 9 });
  assert.match(eloOnlyReport({ proxy: tiny, fullRecords: [], leagues: [] }).skipped, /πολύ λίγοι αγώνες με βαθμολογία Elo/);
});

test('report: a model that is worse than the base rates is flagged (a warning, never the exit code)', () => {
  assert.deepEqual(eloOnlyFlags(null), []);
  assert.deepEqual(eloOnlyFlags({}), []);
  assert.deepEqual(eloOnlyFlags({ skill: { vsBase: { rps: null } } }), []);
  assert.deepEqual(eloOnlyFlags({ skill: { vsBase: { rps: 0 } } }), []);
  assert.deepEqual(eloOnlyFlags({ skill: { vsBase: { rps: 0.09 } } }), []);
  const [flag, ...rest] = eloOnlyFlags({ skill: { vsBase: { rps: -0.0234 } } });
  assert.equal(rest.length, 0);
  assert.equal(flag.code, 'elo-only-below-base');
  assert.match(flag.message, /−?-?2,3% στο RPS/);
  assert.notEqual(flag.code, 'skill-below-8pct');

  // confident forecasts that are wrong a lot: far worse than the base rates
  const bad = Array.from({ length: 400 }, (_, i) => ({
    code: 'AAA',
    key: matchKey(20000 + i, `h${i}`, `a${i}`),
    t: 20000 + i,
    dE: 10,
    lam: 1.5,
    mu: 1.1,
    o: i % 3,
    p: [0.9, 0.05, 0.05],
    pOver: 0.9,
    over: i % 2,
    pBtts: 0.9,
    btts: i % 2,
    base: { p: [0.4, 0.3, 0.3], pOver: 0.5, pBtts: 0.5 },
  }));
  const rep = eloOnlyReport({ proxy: { records: bad, origins: 10, skipped: { origins: 0, reasons: {} }, unrated: 0, fits: [{ kappa: 0.5, eta: 0.2, c: 0.1, rho: -0.05, n: 3000 }] }, fullRecords: [], leagues: ['AAA'] });
  assert.ok(rep.skill.vsBase.rps < 0);
  assert.deepEqual(rep.flags.map((f) => f.code), ['elo-only-below-base']);
  assert.equal(rep.bigGap, null, 'no large rating gaps in this sample: no separate numbers');
});

test('job summary: one line for the Elo-only model, with the league-model comparison when there is one, and a note when it is old', async () => {
  const { renderTuneSummary } = await import('../scripts/job-summary.mjs');
  const better = asLeagueRecords(base.records, (r) => ({ ...r, p: r.p.map((x, i) => 0.7 * x + 0.3 * (i === r.o ? 1 : 0)) }));
  const rep = eloOnlyReport({ proxy: base, fullRecords: better, leagues: ['AAA', 'BBB', 'CCC'] });
  const line = /\*\*Champions League \(μόνο Elo, δοκιμή σε εγχώριους αγώνες\):\*\* (\d+) αγώνες · βελτίωση RPS \d+,\d% έναντι βασικών συχνοτήτων · [-−]\d+,\d% έναντι του πλήρους μοντέλου λίγκας\./;
  const text = renderTuneSummary({ leagues: {}, eloOnly: rep });
  assert.match(text, line);
  assert.equal(Number(line.exec(text)[1]), rep.n);
  assert.doesNotMatch(text, /παλιά αποτελέσματα/);
  assert.match(renderTuneSummary({ leagues: {}, eloOnly: { ...rep, stale: true } }), /έναντι του πλήρους μοντέλου λίγκας \(παλιά αποτελέσματα\)\./);
  // without the league model only the first comparison is printed
  const alone = renderTuneSummary({ leagues: {}, eloOnly: eloOnlyReport({ proxy: base, leagues: ['AAA'] }) });
  assert.match(alone, /έναντι βασικών συχνοτήτων\./);
  assert.doesNotMatch(alone, /πλήρους μοντέλου/);
  // nothing to say: no line, no crash
  for (const bad of [undefined, null, {}, { skipped: 'x' }, { metrics: {} }, 'text']) assert.doesNotMatch(renderTuneSummary({ leagues: {}, eloOnly: bad }), /Champions League \(μόνο Elo/);
});
