// Pure UI helpers (public/util.js): no DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, agoText, ageHours, athensDay, calibrationReasonText, collectEntries, dataBase, dayHeading, fmtDec, fmtPct, fmtPct1, fmtPoints, fmtSkill,
  formatTime, groupByDay, halfLifeDays, lineText, matchBadges, minus, parseHash, parseView, pctSet, rangeOf, rangeText, safeFile, signed, skillTone,
  staleInfo,
} from '../public/util.js';

const NOW = new Date('2026-10-18T10:00:00Z');

test('athensDay follows Athens time including the daylight-saving change (25 Oct 2026)', () => {
  assert.equal(athensDay(new Date('2026-10-18T14:00:00Z')), '2026-10-18');
  assert.equal(athensDay(new Date('2026-10-18T20:59:00Z')), '2026-10-18'); // 23:59 EEST
  assert.equal(athensDay(new Date('2026-10-18T21:00:00Z')), '2026-10-19'); // 00:00 EEST
  // winter time (UTC+2) after the change
  assert.equal(athensDay(new Date('2026-12-01T21:30:00Z')), '2026-12-01'); // 23:30 EET
  assert.equal(athensDay(new Date('2026-12-01T22:00:00Z')), '2026-12-02'); // 00:00 EET
  // the change itself: 25 Oct 2026 at 01:00 UTC clocks go back
  assert.equal(athensDay(new Date('2026-10-25T20:59:00Z')), '2026-10-25'); // 22:59 EET
  assert.equal(athensDay(new Date('2026-10-25T22:00:00Z')), '2026-10-26'); // 00:00 EET
});

test('addDays works over month ends and formatTime never shows 24:00', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(formatTime(new Date('2026-10-18T14:00:00Z')), '17:00');
  assert.equal(formatTime(new Date('2026-10-18T21:00:00Z')), '00:00');
});

test('dayHeading: today, tomorrow and later days in Greek', () => {
  assert.equal(dayHeading('2026-10-18', '2026-10-18'), 'Σήμερα · Κυριακή 18 Οκτωβρίου');
  assert.equal(dayHeading('2026-10-19', '2026-10-18'), 'Αύριο · Δευτέρα 19 Οκτωβρίου');
  assert.equal(dayHeading('2026-10-20', '2026-10-18'), 'Τρίτη 20 Οκτωβρίου');
});

test('fmtPct and pctSet', () => {
  assert.equal(fmtPct(0.523), '52%');
  assert.equal(fmtPct(0.003), '<1%');
  assert.equal(fmtPct(0.996), '>99%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(1), '100%');
  assert.equal(fmtPct(Number.NaN), '–');
  // the three 1X2 numbers of the demo match: 48.3 / 25.2 / 26.4 -> 48 / 25 / 27 (sums to 100)
  assert.deepEqual(pctSet([0.483436, 0.2522, 0.264364]), ['48%', '25%', '27%']);
  assert.deepEqual(pctSet([0.004, 0.996]), ['<1%', '>99%']);
  // any complementary set shows integers that add up to exactly 100
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 300; i++) {
    const raw = [rnd() + 0.01, rnd() + 0.01, rnd() + 0.01, rnd() + 0.01];
    const sum = raw.reduce((a, b) => a + b, 0);
    const shown = pctSet(raw.map((x) => x / sum));
    const total = shown.reduce((a, s) => a + (s === '<1%' ? 0 : s === '>99%' ? 100 : parseInt(s, 10)), 0);
    assert.equal(total, 100, shown.join(',')); // "<1%" stands for the integer 0 and ">99%" for 100
  }
});

test('line and number text: decimal comma and real minus sign', () => {
  assert.equal(lineText(2.5), '2,5');
  assert.equal(lineText(1), '1');
  assert.equal(signed(-1.5), '−1,5');
  assert.equal(signed(0.5), '+0,5');
  assert.equal(signed(1), '+1');
  assert.equal(signed(0), '0');
  assert.equal(minus('-0,028'), '−0,028');
  assert.equal(rangeText([0.404, 0.563]), '40–56%');
  assert.equal(rangeText(null), null);
});

test('rangeOf reads match.ranges (Phase 2 shape) and ignores anything malformed', () => {
  const m = { ranges: { oneX2: { home: [0.4, 0.56] }, over25: [0.45, 0.6], btts: 'bad' } };
  assert.deepEqual(rangeOf(m, 'oneX2.home'), [0.4, 0.56]);
  assert.deepEqual(rangeOf(m, 'over25'), [0.45, 0.6]);
  assert.equal(rangeOf(m, 'btts'), null);
  assert.equal(rangeOf(m, 'oneX2.draw'), null);
  assert.equal(rangeOf({ ranges: null }, 'over25'), null);
  assert.equal(rangeOf({}, 'over25'), null);
  assert.equal(rangeOf({ ranges: { over25: [0.4, Number.NaN] } }, 'over25'), null);
});

test('dataBase: placeholders and unsafe values are rejected, the real value builds the raw.githubusercontent URL', () => {
  assert.deepEqual(dataBase(undefined), { ok: false, reason: 'missing' });
  assert.equal(dataBase({ OWNER: 'YOUR_GITHUB_USERNAME', REPO: 'x', BRANCH: 'data' }).reason, 'unset');
  assert.equal(dataBase({ OWNER: 'me', REPO: 'YOUR_REPOSITORY_NAME' }).reason, 'unset');
  assert.equal(dataBase({ OWNER: '', REPO: 'x' }).reason, 'unset');
  assert.equal(dataBase({ OWNER: 'a/b', REPO: 'x' }).reason, 'unset');
  assert.equal(dataBase({ OWNER: 'me', REPO: 'x y' }).reason, 'unset');
  assert.deepEqual(dataBase({ OWNER: 'alex-1', REPO: 'football.probabilities', BRANCH: 'data' }), {
    ok: true,
    base: 'https://raw.githubusercontent.com/alex-1/football.probabilities/data',
  });
  assert.equal(dataBase({ OWNER: 'me', REPO: 'x' }).base, 'https://raw.githubusercontent.com/me/x/data'); // branch defaults to data
  assert.equal(dataBase({ OWNER: 'me', REPO: 'x', BRANCH: '../evil' }).base, 'https://raw.githubusercontent.com/me/x/data');
  assert.equal(dataBase({ DATA_URL: 'http://localhost:8000/out/' }).base, 'http://localhost:8000/out');
});

test('safeFile only lets plain json file names through', () => {
  assert.equal(safeFile('PL.json'), 'PL.json');
  assert.equal(safeFile('SA_2.json'), 'SA_2.json');
  for (const bad of ['../x.json', 'a/b.json', 'PL.js', 'PL.json?x=1', '', null, undefined, 5, '.json']) assert.equal(safeFile(bad), null, String(bad));
});

test('parseHash picks a known league code, anything else means all leagues', () => {
  const codes = ['PL', 'SA'];
  assert.equal(parseHash('#PL', codes), 'PL');
  assert.equal(parseHash('#sa', codes), 'SA');
  assert.equal(parseHash('#XX', codes), 'ALL');
  assert.equal(parseHash('', codes), 'ALL');
  assert.equal(parseHash(undefined, codes), 'ALL');
  assert.equal(parseHash('#%E0%A4%A', codes), 'ALL'); // malformed escape does not throw
});

const league = (code, matches, extra = {}) => ({ schema: 1, league: { code, name: code, country: '' }, updatedAt: '2026-10-18T05:00:00Z', stale: false, matches, ...extra });
const match = (id, kickoff, extra = {}) => ({ id, kickoff, homeName: 'H', awayName: 'A', flags: {}, ...extra });

test('collectEntries hides started matches and sorts by kick-off, then by league order; groupByDay uses Athens days', () => {
  const pl = league('PL', [match(1, '2026-10-18T09:00:00Z'), match(2, '2026-10-18T14:00:00Z'), match(3, '2026-10-18T21:30:00Z')]);
  const sa = league('SA', [match(4, '2026-10-18T14:00:00Z')]);
  const entries = collectEntries([{ league: pl, order: 1 }, { league: sa, order: 0 }], NOW);
  assert.deepEqual(entries.map((e) => e.key), ['SA:4', 'PL:2', 'PL:3']); // match 1 started 1 h ago
  const groups = groupByDay(entries);
  assert.deepEqual(groups.map((g) => [g.day, g.entries.length]), [['2026-10-18', 2], ['2026-10-19', 1]]); // 21:30Z = 00:30 next day in Athens
});

test('staleInfo: pipeline flag, old timestamp and fresh data', () => {
  assert.equal(staleInfo({ stale: true, staleReason: 'HTTP 500', updatedAt: NOW.toISOString() }, NOW).reason, 'HTTP 500');
  const old = staleInfo({ stale: false, updatedAt: new Date(NOW.getTime() - 31 * 3600000).toISOString() }, NOW);
  assert.equal(old.stale, true);
  assert.match(old.reason, /Τελευταία ενημέρωση πριν από 31 ώρες/);
  assert.equal(staleInfo({ stale: false, updatedAt: new Date(NOW.getTime() - 29 * 3600000).toISOString() }, NOW).stale, false);
  assert.equal(staleInfo({ stale: false }, NOW).stale, true); // no timestamp: not trusted
});

test('matchBadges: promoted / few data / low confidence / stale, with the team names', () => {
  const m = match(1, '2026-10-18T14:00:00Z', {
    homeName: 'Ipswich', awayName: 'Leeds',
    flags: { promotedHome: true, promotedAway: true, fewDataAway: true, lowConfidence: true },
  });
  const fresh = matchBadges(m, league('PL', [m], { updatedAt: NOW.toISOString() }), NOW);
  assert.deepEqual(fresh.map((b) => b.id), ['promoted', 'fewData', 'lowConfidence']);
  assert.equal(fresh[0].text, 'νεοφώτιστη: Ipswich & Leeds');
  assert.equal(fresh[1].text, 'λίγα δεδομένα: Leeds');
  assert.equal(fresh[2].text, 'χαμηλή βεβαιότητα');
  const stale = matchBadges(m, league('PL', [m], { stale: true, staleReason: 'x' }), NOW);
  assert.equal(stale.at(-1).text, 'παλιά δεδομένα');
});

test('agoText and ageHours', () => {
  assert.equal(agoText(0.2), 'πριν από λίγα λεπτά');
  assert.equal(agoText(1), 'πριν από 1 ώρα');
  assert.equal(agoText(5.2), 'πριν από 5 ώρες');
  assert.equal(agoText(49), 'πριν από 2 ημέρες');
  assert.equal(agoText(null), 'πριν από άγνωστο χρόνο');
  assert.equal(ageHours('2026-10-18T09:00:00Z', NOW), 1);
  assert.equal(ageHours('garbage', NOW), null);
  assert.equal(ageHours(undefined, NOW), null);
});

test('parseView: only #reliability opens the report; empty, unknown or broken hashes mean the matches', () => {
  assert.equal(parseView('#reliability'), 'reliability');
  assert.equal(parseView('#Reliability'), 'reliability');
  assert.equal(parseView('reliability'), 'reliability');
  assert.equal(parseView('#reliabilit%79'), 'reliability'); // percent-encoded "y"
  for (const hash of ['', '#', '#PL', '#ALL', '#reliability/extra', '#reliability?x=1', '#reliability%20', undefined, null, 42]) {
    assert.equal(parseView(hash), 'matches', String(hash));
  }
  assert.doesNotThrow(() => parseView('#%E0%A4%A')); // malformed percent-encoding must not throw
  assert.equal(parseView('#%E0%A4%A'), 'matches');
});

test('report number formats: decimal comma, dash for missing values, real minus sign, no sign on zero', () => {
  assert.equal(fmtDec(0.2169), '0,217');
  assert.equal(fmtDec(0.2169, 2), '0,22');
  assert.equal(fmtDec(0.2169, 4), '0,2169');
  assert.equal(fmtDec(0), '0,000');
  assert.equal(fmtDec(-0.0284), '-0,028'); // callers pass it through minus() when they want U+2212
  assert.equal(minus(fmtDec(-0.0284)), '\u22120,028');
  for (const bad of [Number.NaN, Infinity, -Infinity, null, undefined, '0.3', {}]) assert.equal(fmtDec(bad), '–', String(bad));

  assert.equal(fmtPct1(0.126), '12,6%');
  assert.equal(fmtPct1(0), '0,0%');
  assert.equal(fmtPct1(1), '100,0%');
  assert.equal(fmtPct1(Number.NaN), '–');
  assert.equal(fmtPct1('0.1'), '–');

  assert.equal(fmtSkill(0.126), '+12,6%');
  assert.equal(fmtSkill(0.01), '+1,0%');
  assert.equal(fmtSkill(-0.03), '\u22123,0%');
  assert.equal(fmtSkill(0.0004), '0,0%'); // rounds to zero: no sign
  assert.equal(fmtSkill(-0.0004), '0,0%');
  assert.equal(fmtSkill(0), '0,0%');
  assert.equal(fmtSkill(Number.NaN), '–');
  assert.equal(fmtSkill(undefined), '–');

  assert.equal(fmtPoints(0.1177), '11,8 \u03c0.\u03bc.');
  assert.equal(fmtPoints(0), '0,0 \u03c0.\u03bc.');
  assert.equal(fmtPoints(null), '–');
});

test('skillTone: green at or above the 8 % limit, red below, neutral when unknown', () => {
  assert.equal(skillTone(0.126), 'good');
  assert.equal(skillTone(0.08), 'good');
  assert.equal(skillTone(0.0799), 'bad');
  assert.equal(skillTone(0), 'bad');
  assert.equal(skillTone(-0.2), 'bad');
  assert.equal(skillTone(0.05, 0.04), 'good'); // limit taken from report.json
  assert.equal(skillTone(0.05, 0.06), 'bad');
  for (const unknown of [Number.NaN, null, undefined, '0.2']) assert.equal(skillTone(unknown), 'neutral', String(unknown));
});

test('calibrationReasonText: every wording the job can write has a Greek text; unknown wording is passed through', () => {
  assert.match(calibrationReasonText('no clear out-of-sample gain'), /^καμία σαφής βελτίωση/);
  assert.match(calibrationReasonText('improves nested out-of-sample log-loss'), /^βελτιώνει/);
  assert.equal(calibrationReasonText('only 100 matches'), 'μόνο 100 αγώνες: λίγοι για αξιόπιστη εκτίμηση');
  assert.equal(calibrationReasonText('only 7 matches'), 'μόνο 7 αγώνες: λίγοι για αξιόπιστη εκτίμηση');
  assert.equal(calibrationReasonText('something new'), 'something new');
  assert.equal(calibrationReasonText('only 100 matches <b>x</b>'), 'only 100 matches <b>x</b>'); // not matched: shown as plain text by the view
  for (const empty of ['', null, undefined, 5, {}]) assert.equal(calibrationReasonText(empty), '');
});

test('halfLifeDays: ln 2 / xi rounded to whole days, null for unusable values', () => {
  assert.equal(halfLifeDays(0.0019), 365);
  assert.equal(halfLifeDays(0.001), 693);
  assert.equal(halfLifeDays(0.0015), 462);
  assert.equal(halfLifeDays(0.0025), 277);
  assert.equal(halfLifeDays(0.0035), 198);
  for (const bad of [0, -0.001, Number.NaN, Infinity, '0.002', null, undefined]) assert.equal(halfLifeDays(bad), null, String(bad));
});
