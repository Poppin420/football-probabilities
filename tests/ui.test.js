// The browser app in a DOM (jsdom, an optional dev dependency: `npm install`).
// The data are the REAL output of the pipeline, produced from the mock servers,
// so this also guards the contract between the pipeline's JSON and the page.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld, startMockServer } from './mock-world.js';
import { fmtDec, fmtPct, fmtSkill, minus, pctSet, rangeText } from '../public/util.js';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  /* optional dev dependency */
}
const skip = JSDOM ? false : 'jsdom is not installed (run: npm install)';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-18T10:00:00Z');
let FILES = null; // { 'index.json': ..., 'PL.json': ... } from the real pipeline
let ELO_ONLY = null; // report.eloOnly built by the code of the weekly job (see below)
let createApp = null;

if (JSDOM) {
  const server = await startMockServer(buildWorld());
  Object.assign(process.env, {
    FD_ORG_BASE: `${server.url}/v4`, FD_CSV_BASE: `${server.url}/mmz4281`, ELO_BASE: server.url,
    FD_ORG_MIN_INTERVAL_MS: '0', CSV_PAUSE_MS: '0', HTTP_BACKOFF_MS: '0',
  });
  const { runRefresh } = await import('../src/pipeline/refresh.js');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ui-out-'));
  const quiet = { log() {}, warn() {}, error() {} };
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: 'test-token' }, prevDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ui-prev-')), outDir,
    aliasesPath: path.join(ROOT, 'aliases.json'), now: NOW, logger: quiet, only: ['PL'],
  });
  assert.equal(res.exitCode, 0);
  // the weekly back-test on the same mock servers: its report.json feeds the view "Αξιοπιστία"
  const { runTune } = await import('../src/pipeline/tune.js');
  const tuneOut = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ui-tune-'));
  const tuned = await runTune({
    prevDir: outDir, outDir: tuneOut, aliasesPath: path.join(ROOT, 'aliases.json'), now: NOW, logger: quiet, only: ['PL'], bootstrapK: 6, sleepFn: async () => {},
  });
  assert.equal(tuned.publish, true);
  await server.close();
  FILES = Object.fromEntries(['index.json', 'PL.json'].map((f) => [f, JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))]));
  FILES['report.json'] = JSON.parse(fs.readFileSync(path.join(tuneOut, 'report.json'), 'utf8'));
  // report.eloOnly (Elo-only model of the Champions League tested on domestic matches): the weekly job on one mock
  // league has too few rated matches for it, so the block comes from the synthetic world of the model tests,
  // built by the same code (a stand-in league model that is a bit better than the Elo-only one).
  const { buildEloOnlyWorld, asLeagueRecords } = await import('./elo-only-world.js');
  const { runEloOnlyBacktest } = await import('../src/pipeline/eloOnlyBacktest.js');
  const { eloOnlyReport } = await import('../src/pipeline/tune.js');
  const eloWorld = buildEloOnlyWorld();
  const proxy = runEloOnlyBacktest({ domestic: eloWorld.domestic, from: eloWorld.from, to: eloWorld.to });
  const better = asLeagueRecords(proxy.records, (r) => ({ ...r, p: r.p.map((x, i) => 0.7 * x + 0.3 * (i === r.o ? 1 : 0)) }));
  ELO_ONLY = eloOnlyReport({ proxy, fullRecords: better, leagues: ['AAA', 'BBB', 'CCC'] });
  // app.js starts itself in a browser: tell it not to while importing it into Node.
  globalThis.window = { __FP_NO_AUTOSTART: true };
  ({ createApp } = await import('../public/app.js'));
  delete globalThis.window;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const dec = (x, n = 2) => x.toFixed(n).replace('.', ',');

/** What the page must show for the first match (Arsenal - Chelsea), derived from the pipeline's JSON. */
function expected(files = FILES) {
  const m = files['PL.json'].matches[0];
  const x = m.goals.oneX2;
  const [h, d, a] = pctSet([x.home, x.draw, x.away]);
  const o25 = m.goals.totals.find((t) => t.line === 2.5);
  const [over, under] = pctSet([o25.over, o25.under]);
  const [yes, no] = pctSet([m.goals.btts.yes, m.goals.btts.no]);
  return { m, h, d, a, o25, over, under, yes, no, top: m.goals.correctScores[0], striker: m.scorers.home[0] };
}
const OK_CONFIG = { OWNER: 'tester', REPO: 'demo', BRANCH: 'data' };
const dom = [];
after(() => dom.forEach((d) => d.window.close()));

/** fetch that serves `files`; a file set to a number answers with that HTTP status, `null` throws like a dead network. */
function fakeFetch(files, calls = []) {
  return async (url) => {
    const name = String(url).split('/').pop();
    calls.push(String(url));
    const v = files[name];
    if (v === null) throw new TypeError('network down');
    if (typeof v === 'number') return new Response('nope', { status: v });
    if (v === undefined) return new Response('404: Not Found', { status: 404 });
    return new Response(JSON.stringify(v), { status: 200 });
  };
}

async function boot({ files = clone(FILES), config = OK_CONFIG, now = NOW, hash = '', calls = [], storage, blockStorage = false } = {}) {
  const d = new JSDOM(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), { url: `https://example.test/${hash}`, pretendToBeVisual: true });
  dom.push(d);
  const win = d.window;
  win.scrollTo = () => {};
  if (blockStorage) Object.defineProperty(win, 'localStorage', { get() { throw new Error('storage blocked'); } });
  const fetchFn = fakeFetch(files, calls);
  const app = createApp({ doc: win.document, win, fetchFn, config, nowFn: () => now, ...(storage ? { storage } : {}) });
  // The returned fetch can be swapped later (retry tests) by mutating `files`.
  await app.start();
  await settle(win);
  return { win, doc: win.document, app, files, calls };
}

async function settle(win) {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (win.document.getElementById('app').getAttribute('aria-busy') !== 'true') {
      await new Promise((r) => setTimeout(r, 5));
      return;
    }
  }
  throw new Error('the app stayed busy');
}

/** Visible text with a space between separate text nodes (like a screen reader announces it). */
function text(el) {
  if (!el) return '';
  const parts = [];
  const walk = (n) => {
    if (n.nodeType === 3) parts.push(n.nodeValue);
    else for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
const cards = (doc) => [...doc.querySelectorAll('article.card')];
const tabButton = (card, label) => [...card.querySelectorAll('.tab')].find((b) => b.textContent === label);

test('config.js not edited yet: a friendly set-up card, nothing is fetched', { skip }, async () => {
  const calls = [];
  const { doc } = await boot({ config: { OWNER: 'YOUR_GITHUB_USERNAME', REPO: 'YOUR_REPOSITORY_NAME', BRANCH: 'data' }, calls });
  assert.match(text(doc.getElementById('app')), /δεν έχει ρυθμιστεί ακόμα/);
  assert.match(text(doc.getElementById('app')), /OWNER/);
  assert.equal(calls.length, 0);
  const missing = await boot({ config: null });
  assert.match(text(missing.doc.getElementById('app')), /Λείπει το αρχείο config\.js/);
});

test('list: chips, Athens times, date groups, one card per upcoming match, data from the right URL', { skip }, async () => {
  const calls = [];
  const { doc } = await boot({ calls });
  assert.equal(calls[0], 'https://raw.githubusercontent.com/tester/demo/data/index.json');
  assert.ok(calls.includes('https://raw.githubusercontent.com/tester/demo/data/PL.json'));
  assert.deepEqual([...doc.querySelectorAll('.chip')].map((c) => c.textContent), ['Όλες', 'Premier League']);
  assert.equal(doc.querySelector('.chip[aria-pressed="true"]').textContent, 'Όλες');
  assert.equal(cards(doc).length, 9);
  assert.equal(text(doc.querySelector('.day-h')), 'Σήμερα · Κυριακή 18 Οκτωβρίου');
  const first = cards(doc)[0];
  assert.equal(text(first.querySelector('.time')), '17:00'); // 14:00 UTC = 17:00 in Athens (summer time)
  assert.equal(text(first.querySelector('.teams')), 'Arsenal – Chelsea');
  const e = expected();
  assert.ok(e.m.ranges, 'Phase 2 data carry the bootstrap ranges');
  const r = e.m.ranges;
  assert.equal(text(first.querySelector('.x12')), `1 ${e.h} ${rangeText(r.oneX2.home)} Χ ${e.d} ${rangeText(r.oneX2.draw)} 2 ${e.a} ${rangeText(r.oneX2.away)}`);
  assert.equal(text(first.querySelector('.quick')), `Over 2,5 ${fmtPct(e.o25.over)} ${rangeText(r.over25)} GG ${fmtPct(e.m.goals.btts.yes)} ${rangeText(r.btts)} xG ${dec(e.m.model.lam)} – ${dec(e.m.model.mu)}`);
  assert.match(text(doc.getElementById('updated')), /^Τελευταία ενημέρωση: 18 Οκτ 2026, 13:00 \(ώρα Ελλάδας\)$/);
  assert.equal(doc.getElementById('warnings').hidden, false);
  assert.equal(text(doc.getElementById('warnings-count')), String(FILES['index.json'].warnings.length));
  assert.equal(doc.getElementById('status').textContent, '9 αγώνες');
});

test('card opens, shows six tabs, every tab renders and carries the pipeline numbers', { skip }, async () => {
  const { doc } = await boot();
  const card = cards(doc)[0];
  const head = card.querySelector('.card-head');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(card.querySelector('.panel').hidden, true);
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(card.querySelector('.panel').hidden, false);
  assert.deepEqual([...card.querySelectorAll('.tab')].map((t) => t.textContent), ['Αποτέλεσμα', 'Γκολ', 'Κόρνερ', 'Κάρτες', 'Σκόρερ', 'Ανάλυση']);
  const panelText = () => text(card.querySelector('.tp'));
  const e = expected();
  const rg = e.m.ranges.oneX2;
  assert.ok(panelText().includes(`Τελικό αποτέλεσμα (1Χ2) 1 · Νίκη Arsenal ${e.h} (${rangeText(rg.home)}) Χ · Ισοπαλία ${e.d} (${rangeText(rg.draw)}) 2 · Νίκη Chelsea ${e.a} (${rangeText(rg.away)})`), panelText().slice(0, 200));
  assert.ok(panelText().includes(`${e.top.home}–${e.top.away} ${fmtPct(e.top.p)}`), 'most likely score');
  assert.match(panelText(), /Arsenal −1,5/); // real minus sign in handicaps

  tabButton(card, 'Γκολ').click();
  assert.equal(tabButton(card, 'Γκολ').getAttribute('aria-selected'), 'true');
  assert.equal(tabButton(card, 'Αποτέλεσμα').getAttribute('aria-selected'), 'false');
  assert.ok(panelText().includes(`2,5 γκολ Over ${e.over} Under ${e.under}`), panelText().slice(0, 300));
  assert.ok(panelText().includes(`GG Ναι ${e.yes} Όχι ${e.no}`));

  tabButton(card, 'Κόρνερ').click();
  assert.match(panelText(), /Αναμενόμενα κόρνερ.*Σύνολο 11,0/);
  assert.match(panelText(), /9,5 κόρνερ Over 63%/);

  tabButton(card, 'Κάρτες').click();
  assert.match(panelText(), /Αναμενόμενες κάρτες.*Σύνολο 3,7/);
  const ref = e.m.cards.referee;
  assert.ok(ref && ref.name, 'the pipeline names the referee (Phase 3)');
  assert.ok(panelText().includes(`Διαιτητής: ${ref.name} · ${ref.matches} αγώνες στη βάση · συντελεστής ×${dec(e.m.cards.refereeFactor, 2)} (πιο αυστηρός από τον μέσο όρο)`), panelText().slice(0, 400));
  assert.match(panelText(), /Πόντοι κράτησης \(κίτρινη = 10, κόκκινη = 25\)/);

  tabButton(card, 'Σκόρερ').click();
  assert.match(panelText(), /Δεν υπάρχουν διαθέσιμες συνθέσεις/);
  assert.ok(panelText().includes(`Arsenal Striker ${e.striker.goals} γκολ φέτος ${fmtPct(e.striker.anytime)} ${fmtPct(e.striker.twoPlus)} ${fmtPct(e.striker.first)}`), panelText().slice(0, 300));

  tabButton(card, 'Ανάλυση').click();
  assert.match(panelText(), /Το μοντέλο θεωρεί (ελαφρύ )?φαβορί την ομάδα Arsenal/);
  assert.match(panelText(), /Elo Arsenal 2030 · Chelsea 1900/);
  assert.ok(panelText().includes(`Διόρθωση χαμηλών σκορ (ρ) ${minus(dec(e.m.model.rho, 3))}`));

  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(card.querySelector('.panel').hidden, true);
});

test('keyboard: arrow keys move between tabs and keep the focus on the tab bar', { skip }, async () => {
  const { doc, win } = await boot();
  const card = cards(doc)[0];
  card.querySelector('.card-head').click();
  const tab = tabButton(card, 'Αποτέλεσμα');
  tab.focus();
  tab.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(tabButton(card, 'Γκολ').getAttribute('aria-selected'), 'true');
  assert.equal(doc.activeElement, tabButton(card, 'Γκολ'));
  tabButton(card, 'Γκολ').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(doc.activeElement, tabButton(card, 'Ανάλυση'));
  tabButton(card, 'Ανάλυση').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement, tabButton(card, 'Αποτέλεσμα')); // wraps around
});

test('matches that have kicked off are hidden', { skip }, async () => {
  const { doc } = await boot({ now: new Date('2026-10-18T14:30:00Z') }); // the 14:00 UTC match has started
  assert.equal(cards(doc).length, 8);
  assert.ok(!text(doc.getElementById('app')).includes('Arsenal – Chelsea'));
});

test('league hash selects a league; an unknown hash shows all', { skip }, async () => {
  const pl = await boot({ hash: '#PL' });
  assert.equal(pl.doc.querySelector('.chip[aria-pressed="true"]').textContent, 'Premier League');
  assert.equal(text(pl.doc.querySelector('.meta')).includes('Premier League'), false); // league name only shown in the "all" view
  const unknown = await boot({ hash: '#ZZ' });
  assert.equal(unknown.doc.querySelector('.chip[aria-pressed="true"]').textContent, 'Όλες');
  assert.ok(text(unknown.doc.querySelector('.meta')).includes('Premier League'));
});

test('stale data: pipeline flag -> banner and badge; old index -> red banner; fresh data -> neither', { skip }, async () => {
  const fresh = await boot();
  assert.equal(fresh.doc.querySelectorAll('.banner').length, 0);
  assert.equal(fresh.doc.querySelectorAll('.pill.bad').length, 0);

  const files = clone(FILES);
  files['PL.json'].stale = true;
  files['PL.json'].staleReason = 'football-data.org: HTTP 500';
  files['index.json'].leagues[0].stale = true;
  const flagged = await boot({ files });
  assert.match(text(flagged.doc.getElementById('banner')), /Παλιά δεδομένα για: Premier League/);
  assert.equal(flagged.doc.querySelectorAll('.pill.bad').length, 9);
  assert.match(flagged.doc.querySelector('.chip[data-code="PL"]').textContent, /⚠/);

  const old = clone(FILES);
  old['index.json'].generatedAt = '2026-10-15T09:00:00.000Z';
  const aged = await boot({ files: old });
  assert.match(text(aged.doc.getElementById('banner')), /Τα δεδομένα είναι παλιά: τελευταία ενημέρωση πριν από 3 ημέρες/);
  assert.ok(aged.doc.querySelector('.banner.bad'));
});

test('errors: data branch not published, offline (with a working retry), broken JSON, newer schema', { skip }, async () => {
  const notYet = await boot({ files: { 'index.json': 404 } });
  assert.match(text(notYet.doc.getElementById('app')), /Δεν υπάρχουν δεδομένα ακόμα.*Run workflow/);
  assert.equal(notYet.doc.querySelectorAll('.chip').length, 0);

  const files = clone(FILES);
  const offlineFiles = { ...files, 'index.json': null };
  const off = await boot({ files: offlineFiles });
  assert.match(text(off.doc.getElementById('app')), /Δεν υπάρχει σύνδεση/);
  // the network comes back and the person taps "Δοκίμασε ξανά"
  offlineFiles['index.json'] = files['index.json'];
  off.doc.querySelector('.retry').click();
  await settle(off.win);
  assert.equal(cards(off.doc).length, 9);

  const http = await boot({ files: { 'index.json': 503 } });
  assert.match(text(http.doc.getElementById('app')), /HTTP 503/);

  const schema = clone(FILES);
  schema['index.json'].schema = 2;
  const newer = await boot({ files: schema });
  assert.match(text(newer.doc.getElementById('app')), /νεότερη μορφή/);

  const noLeagues = clone(FILES);
  noLeagues['index.json'].leagues = [];
  assert.match(text((await boot({ files: noLeagues })).doc.getElementById('app')), /Δεν υπάρχουν πρωταθλήματα/);
});

test('a league whose file is missing is reported, the others still show', { skip }, async () => {
  // second league = copy of PL under another code, its file answers 404
  const files = clone(FILES);
  const entry = { ...files['index.json'].leagues[0], code: 'SA', name: 'Serie A', file: 'SA.json' };
  files['index.json'].leagues.push(entry);
  const { doc } = await boot({ files });
  assert.match(text(doc.getElementById('app')), /Serie A: δεν φορτώθηκε \(HTTP 404\)/);
  assert.equal(cards(doc).length, 9);
  // a league the pipeline could not build at all (file: null) is a disabled chip, not an error
  const f2 = clone(FILES);
  f2['index.json'].leagues.push({ code: 'BL1', name: 'Bundesliga', file: null, status: 'error', stale: true });
  const b = await boot({ files: f2 });
  assert.equal(b.doc.querySelector('.chip[data-code="BL1"]').disabled, true);
  assert.equal(cards(b.doc).length, 9);
});

test('only one league and it fails: full message with a retry for that league', { skip }, async () => {
  const files = clone(FILES);
  files['PL.json'] = 500;
  const { doc, files: f } = await boot({ files });
  assert.match(text(doc.getElementById('app')), /HTTP 500/);
  f['PL.json'] = FILES['PL.json'];
  doc.querySelector('.retry').click();
  await settle(doc.defaultView);
  assert.equal(cards(doc).length, 9);
});

test('external text is never interpreted as HTML (team, player and analysis text)', { skip }, async () => {
  const files = clone(FILES);
  const m = files['PL.json'].matches[0];
  m.homeName = '<img src=x onerror=alert(1)>';
  m.scorers.home[0].name = '<script>alert(2)</script>';
  m.analysis.text = '<b onmouseover=alert(3)>hi</b>';
  files['index.json'].warnings.push({ code: 'x', message: '<iframe src=//evil></iframe>' });
  const { doc } = await boot({ files });
  const card = cards(doc)[0];
  card.querySelector('.card-head').click();
  tabButton(card, 'Σκόρερ').click();
  tabButton(card, 'Ανάλυση').click();
  assert.equal(doc.querySelectorAll('img, script:not([src]), iframe, b[onmouseover]').length, 0);
  assert.ok(text(card).includes('<img src=x onerror=alert(1)>'));
  assert.ok(text(card).includes('<b onmouseover=alert(3)>hi</b>'));
  assert.ok(text(doc.getElementById('warnings-list')).includes('<iframe src=//evil></iframe>'));
});

test('Phase 2 ranges (10-90%) appear next to the main markets when the data carry them', { skip }, async () => {
  const files = clone(FILES);
  files['PL.json'].matches[1].ranges = null; // e.g. a league refreshed by Phase 1 code, or a failed bootstrap
  files['PL.json'].matches[0].ranges = {
    oneX2: { home: [0.4, 0.56], draw: [0.21, 0.29], away: [0.2, 0.33] }, over25: [0.45, 0.6], btts: [0.48, 0.62],
  };
  const { doc } = await boot({ files });
  const card = cards(doc)[0];
  const e = expected(files);
  assert.equal(text(card.querySelector('.x12')), `1 ${e.h} 40–56% Χ ${e.d} 21–29% 2 ${e.a} 20–33%`);
  assert.match(text(card.querySelector('.quick')), new RegExp(`Over 2,5 ${fmtPct(e.o25.over)} 45–60%.*GG ${fmtPct(e.m.goals.btts.yes)} 48–62%`));
  card.querySelector('.card-head').click();
  assert.ok(text(card.querySelector('.tp')).includes(`1 · Νίκη Arsenal ${e.h} (40–56%)`));
  assert.equal(text(cards(doc)[1].querySelector('.x12')).includes('–'), false); // a match without ranges shows none
});

test('leagues without corner / card / scorer data show a clear message instead of failing', { skip }, async () => {
  const files = clone(FILES);
  Object.assign(files['PL.json'].matches[0], { corners: null, cards: null, scorers: null });
  const { doc } = await boot({ files });
  const card = cards(doc)[0];
  card.querySelector('.card-head').click();
  tabButton(card, 'Κόρνερ').click();
  assert.match(text(card.querySelector('.tp')), /Δεν υπάρχουν αρκετά δεδομένα για κόρνερ/);
  tabButton(card, 'Κάρτες').click();
  assert.match(text(card.querySelector('.tp')), /Δεν υπάρχουν αρκετά δεδομένα για κάρτες/);
  tabButton(card, 'Σκόρερ').click();
  assert.match(text(card.querySelector('.tp')), /Δεν υπάρχουν δεδομένα σκόρερ/);
});

test('a damaged match does not break the rest of the list', { skip }, async () => {
  const files = clone(FILES);
  delete files['PL.json'].matches[2].goals;
  const { doc } = await boot({ files });
  assert.equal(cards(doc).length, 9);
  assert.equal(doc.querySelectorAll('.card.broken').length, 1);
  assert.match(text(doc.querySelector('.card.broken')), /Δεν ήταν δυνατή η εμφάνιση του αγώνα/);
});

test('blocked browser storage (private mode) does not break the page; theme toggle still works', { skip }, async () => {
  const { doc, win } = await boot({ blockStorage: true });
  assert.equal(cards(doc).length, 9);
  const before = doc.documentElement.dataset.theme;
  doc.getElementById('theme').click();
  assert.notEqual(doc.documentElement.dataset.theme, before);
  assert.ok(['dark', 'light'].includes(doc.documentElement.dataset.theme));
  doc.querySelector('.chip[data-code="PL"]').click(); // selecting a chip also writes storage
  assert.equal(doc.querySelector('.chip[aria-pressed="true"]').textContent, 'Premier League');
  assert.equal(win.location.hash, '#PL');
});

test('footer credits the sources (API-Football only when its data are used), with the exact sentence football-data.org asks for; links open safely', { skip }, async () => {
  const { doc } = await boot();
  const foot = text(doc.querySelector('footer'));
  assert.match(foot, /Football data provided by the Football-Data\.org API/);
  assert.match(foot, /football-data\.co\.uk/);
  assert.match(foot, /clubelo\.com/);
  // the mock run had no API-Football key: its credit, the note about absences and the Champions League note stay hidden
  const shown = (d) => [...d.querySelectorAll('footer a')].filter((a) => !a.closest('[hidden]'));
  assert.deepEqual(shown(doc).map((a) => new URL(a.href).hostname), ['www.football-data.co.uk', 'clubelo.com', 'www.football-data.org']);
  for (const id of ['credit-apif', 'foot-absences', 'foot-cl']) assert.equal(doc.getElementById(id).hidden, true, id);
  for (const a of doc.querySelectorAll('footer a')) {
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  }

  // once the data come (also partly) from API-Football, it is credited as the terms ask
  for (const status of ['ok', 'stale']) {
    const files = clone(FILES);
    files['index.json'].sources = { ...files['index.json'].sources, apiFootball: { status } };
    const withApif = await boot({ files });
    assert.equal(withApif.doc.getElementById('credit-apif').hidden, false, status);
    assert.equal(withApif.doc.getElementById('foot-absences').hidden, false, status);
    assert.deepEqual(shown(withApif.doc).map((a) => new URL(a.href).hostname), ['www.football-data.co.uk', 'clubelo.com', 'www.api-football.com', 'www.football-data.org']);
  }
  // 'off' / 'error' mean no data from it: no credit
  for (const status of ['off', 'error']) {
    const files = clone(FILES);
    files['index.json'].sources = { ...files['index.json'].sources, apiFootball: { status } };
    assert.equal((await boot({ files })).doc.getElementById('credit-apif').hidden, true, status);
  }
});

// ---------------------------------------------------------------- view "Αξιοπιστία" --

const viewBtn = (doc, view) => doc.querySelector(`.view-btn[data-view="${view}"]`);
const REPORT_URL = 'https://raw.githubusercontent.com/tester/demo/data/report.json';

/** A report whose league passes the 8 % limit (the mock league itself is weaker than that). */
// Class names of the direct children of a league card's <summary> (first class only).
const summaryParts = (details) => [...details.firstElementChild.children].map((el) => el.className.split(' ')[0]);

function healthyReport() {
  const files = clone(FILES);
  const r = files['report.json'];
  r.leagues.PL.skill.vsBase.rps = 0.126;
  r.leagues.PL.flags = [];
  r.pooled.skill.vsBase.rps = 0.126;
  r.pooled.flags = [];
  return files;
}

test('view switch: the report is fetched only when asked for, the league chips hide, and "Αγώνες" brings everything back', { skip }, async () => {
  const calls = [];
  const { doc, win } = await boot({ calls });
  assert.ok(!calls.includes(REPORT_URL), 'no report request on the matches view');
  assert.equal(viewBtn(doc, 'matches').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.getElementById('league-nav').hidden, false);

  viewBtn(doc, 'reliability').click();
  await settle(win);
  assert.equal(calls.filter((u) => u === REPORT_URL).length, 1);
  assert.equal(viewBtn(doc, 'reliability').getAttribute('aria-pressed'), 'true');
  assert.equal(viewBtn(doc, 'matches').getAttribute('aria-pressed'), 'false');
  assert.equal(doc.getElementById('league-nav').hidden, true);
  assert.equal(win.location.hash, '#reliability');
  assert.equal(cards(doc).length, 0);
  assert.match(text(doc.getElementById('app')), /Πόσο αξιόπιστες είναι οι πιθανότητες;/);

  viewBtn(doc, 'matches').click();
  await settle(win);
  assert.equal(doc.getElementById('league-nav').hidden, false);
  assert.equal(cards(doc).length, 9);
  assert.equal(win.location.hash, '');

  // a second visit does not download the report again
  viewBtn(doc, 'reliability').click();
  await settle(win);
  assert.equal(calls.filter((u) => u === REPORT_URL).length, 1);
});

test('view switch: a league chosen before is remembered and the URL follows the view', { skip }, async () => {
  const { doc, win } = await boot({ hash: '#PL' });
  assert.equal(win.location.hash, '#PL');
  viewBtn(doc, 'reliability').click();
  await settle(win);
  assert.equal(win.location.hash, '#reliability');
  viewBtn(doc, 'matches').click();
  await settle(win);
  assert.equal(win.location.hash, '#PL');
  assert.equal(doc.querySelector('.chip[aria-pressed="true"]').textContent, 'Premier League');
});

test('direct link #reliability opens the report straight away; the hash change also switches views', { skip }, async () => {
  const calls = [];
  const { doc, win } = await boot({ hash: '#reliability', calls });
  assert.equal(viewBtn(doc, 'reliability').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.getElementById('league-nav').hidden, true);
  assert.ok(calls.includes(REPORT_URL));
  assert.ok(!calls.some((u) => u.endsWith('/PL.json')), 'the league files are not needed for the report');
  assert.match(text(doc.getElementById('app')), /Premier League/);

  win.location.hash = '#PL';
  win.dispatchEvent(new win.HashChangeEvent('hashchange'));
  await settle(win);
  assert.equal(viewBtn(doc, 'matches').getAttribute('aria-pressed'), 'true');
  assert.equal(cards(doc).length, 9);
});

test('report: the page shows exactly the numbers of report.json', { skip }, async () => {
  const files = healthyReport();
  const r = files['report.json'];
  const pl = r.leagues.PL;
  const { doc, win } = await boot({ files, hash: '#reliability' });
  const app = doc.getElementById('app');
  const t = text(app);

  // pooled tiles
  assert.ok(t.includes(`Αγώνες ελέγχου ${r.pooled.matches}`), t.slice(0, 400));
  assert.ok(t.includes(`Βελτίωση έναντι συχνοτήτων (RPS) ${fmtSkill(0.126)}`));
  assert.ok(t.includes('≥ 8%'));
  assert.equal(doc.querySelectorAll('.banner.bad').length, 0, 'a league that passes the limit raises no alarm');

  // league row
  const row = app.querySelector('details.rel-league[data-code="PL"]');
  assert.ok(row);
  assert.equal(text(row.querySelector('.rl-name')), `Premier League ${pl.matches} αγώνες`);
  assert.equal(text(row.querySelector('.rl-skill')), fmtSkill(0.126));
  assert.ok(row.querySelector('.rl-skill').classList.contains('good'));

  // metrics table: model row, base-rate row, Poisson row, previous-version row
  const rows = [...row.querySelectorAll('table.rel-t')[0].querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(rows.length, 4);
  const m = pl.metrics;
  assert.ok(rows[0].includes(`Μοντέλο ${fmtDec(m.model.x12.rps)} ${fmtDec(m.model.x12.logLoss)} ${fmtDec(m.model.ou25.logLoss)} ${fmtDec(m.model.btts.logLoss)}`), rows[0]);
  assert.ok(rows[1].includes(fmtDec(m.base.x12.rps)));
  assert.ok(rows[2].includes(fmtDec(m.poisson.x12.rps)));
  assert.ok(rows[3].includes(fmtDec(m.phase1.x12.rps)));

  // improvement table: three references, signed numbers with a decimal comma
  const sk = [...row.querySelectorAll('table.rel-t')[1].querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(sk.length, 3);
  assert.ok(sk[0].includes(fmtSkill(0.126)));
  assert.ok(sk[1].includes(fmtSkill(pl.skill.vsPoisson.rps)));
  assert.ok(/[+−]?\d+,\d%/.test(sk[2]));

  // early season / rest of the season
  const seasonTable = [...row.querySelectorAll('table.rel-t')].find((tb) => /Αρχή σεζόν/.test(text(tb)));
  assert.ok(seasonTable);
  assert.ok(text(seasonTable).includes(String(pl.season.rest.n)));

  // calibration: five markets with their slope, bins in a table
  const subs = [...row.querySelectorAll('details.rel-sub')].filter((d) => /κλίση/.test(text(d.querySelector('summary'))));
  assert.equal(subs.length, 5);
  assert.ok(text(subs[0].querySelector('summary')).includes(`κλίση ${fmtDec(pl.calibration.home.slope, 2)}`));
  assert.equal(subs[0].querySelectorAll('tbody tr').length, pl.calibration.home.bins.length);

  // corners / yellow cards versus Poisson
  const counts = [...row.querySelectorAll('section.blk')].find((b) => /Κόρνερ και κίτρινες κάρτες/.test(text(b.querySelector('h4'))));
  assert.ok(counts && text(counts).includes(String(pl.counts.corners.n)));

  // half-time markets (Phase 3): model vs base rates, with the signed improvement
  assert.ok(pl.htft && pl.htft.n >= 200, 'fixture: the mock league has half-time scores');
  const half = [...row.querySelectorAll('section.blk')].find((b) => /Ημίχρονο και ημίχρονο\/τελικός/.test(text(b.querySelector('h4'))));
  assert.ok(half, 'half-time block');
  const hrows = [...half.querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(hrows.length, 5);
  const trio = (model, base, skill) => `${fmtDec(model)} ${fmtDec(base)} ${fmtSkill(skill)}`;
  assert.ok(hrows[0].includes(trio(pl.htft.model.ht.rps, pl.htft.base.ht.rps, pl.htft.skill.htRps)), hrows[0]);
  assert.ok(hrows[1].includes(trio(pl.htft.model.ht.logLoss, pl.htft.base.ht.logLoss, pl.htft.skill.htLogLoss)), hrows[1]);
  assert.ok(hrows[2].includes(trio(pl.htft.model.htft.logLoss, pl.htft.base.htft.logLoss, pl.htft.skill.htft)), hrows[2]);
  assert.ok(hrows[3].includes(trio(pl.htft.model.over05.logLoss, pl.htft.base.over05.logLoss, pl.htft.skill.over05)), hrows[3]);
  assert.ok(hrows[4].includes(trio(pl.htft.model.over15.logLoss, pl.htft.base.over15.logLoss, pl.htft.skill.over15)), hrows[4]);
  assert.ok(text(half).includes(`${pl.htft.n} αγώνες με σκορ ημιχρόνου`));
  assert.match(t, /Το Champions League δεν ελέγχεται εδώ/);

  // chosen parameters
  const tech = text(row.querySelector('dl.tech'));
  assert.ok(tech.includes(pl.tuning.source === 'tuned' ? 'βελτιστοποιημένες' : 'προεπιλογές'));
  assert.ok(tech.includes(`Φθίνουσα βαρύτητα παλαιότητας (ξ) ${pl.params.xi.toFixed(4).replace('.', ',')}`), tech);

  // details of the job, calibration layer and warnings
  assert.match(t, /Προαιρετική διόρθωση πιθανοτήτων/);
  assert.match(t, /σεζόν ελέγχου 2024\/25, 2025\/26/);
  assert.match(t, /bootstrap 6 επαναλήψεων/);
  assert.match(t, /Ειδοποιήσεις ελέγχου \(\d+\)/);
  assert.ok(win.document.querySelectorAll('img, script:not([src]), iframe').length === 0);
});

test('report: a league below the 8 % limit is flagged in red, with the job\'s own message', { skip }, async () => {
  const { doc } = await boot({ hash: '#reliability' }); // the mock league is weaker than the limit
  const app = doc.getElementById('app');
  const pl = FILES['report.json'].leagues.PL;
  assert.ok(pl.skill.vsBase.rps < 0.08, 'fixture: the mock league is below the limit');
  const top = app.querySelector('.banner.bad');
  assert.ok(top, 'top banner');
  assert.match(text(top), /Premier League ξεπερνά τις βασικές συχνότητες λιγότερο από 8% στο RPS/);
  const row = app.querySelector('details.rel-league');
  assert.ok(row.classList.contains('flagged'));
  assert.ok(row.querySelector('.rl-skill').classList.contains('bad'));
  assert.match(text(row.querySelector('.badges')), /κάτω από το όριο/);
  assert.ok(text(row.querySelector('.rl-body .banner.bad')).includes(pl.flags[0].message));
  assert.deepEqual(summaryParts(row), ['rl-name', 'rl-skill'], 'the tag sits inside the name block, so the summary grid stays "name | skill | caret"');
  assert.ok(row.querySelector('summary .rl-name .badges'));
});

test('report: stale, failed and hostile entries render safely', { skip }, async () => {
  const files = healthyReport();
  const r = files['report.json'];
  r.leagues.BL1 = { ...clone(r.leagues.PL), name: 'Bundesliga', stale: true, staleReason: 'timeout', staleSince: '2026-10-05T03:37:00Z' };
  r.leagues.SA = { name: 'Serie A', error: 'δεν κατέβηκαν τα δεδομένα' };
  r.leagues.XX = { ...clone(r.leagues.PL), name: '<img src=x onerror=alert(1)>', flags: [{ code: 'x', message: '<b onmouseover=alert(3)>hi</b>' }] };
  r.warnings.push({ code: 'w', message: '<iframe src=//evil></iframe>' });
  const { doc } = await boot({ files, hash: '#reliability' });
  const app = doc.getElementById('app');
  const bl1 = app.querySelector('details[data-code="BL1"]');
  assert.match(text(bl1.querySelector('.badges')), /παλιά αποτελέσματα/);
  assert.deepEqual(summaryParts(bl1), ['rl-name', 'rl-skill']);
  assert.ok(!bl1.classList.contains('flagged'));
  assert.ok(text(bl1.querySelector('.rl-body .banner.warn')).includes('timeout'));
  const sa = [...app.querySelectorAll('.rel-error')].find((el) => /Serie A/.test(text(el)));
  assert.ok(sa && text(sa).includes('δεν κατέβηκαν τα δεδομένα'));
  assert.equal(app.querySelectorAll('img, iframe, b[onmouseover]').length, 0);
  assert.ok(text(app).includes('<img src=x onerror=alert(1)>'));
  assert.ok(text(app).includes('<b onmouseover=alert(3)>hi</b>'));
  assert.ok(text(app).includes('<iframe src=//evil></iframe>'));
});

test('report: the Champions League card (Elo-only model tested on domestic matches) shows exactly the numbers of report.eloOnly', { skip }, async () => {
  assert.ok(ELO_ONLY && ELO_ONLY.metrics && ELO_ONLY.leagueModel && ELO_ONLY.bigGap, 'fixture: all parts of the block exist');
  const files = healthyReport();
  files['report.json'].eloOnly = clone(ELO_ONLY);
  const e = files['report.json'].eloOnly;
  const { doc } = await boot({ files, hash: '#reliability' });
  const app = doc.getElementById('app');
  const card = app.querySelector('details.rel-league[data-code="CL"]');
  assert.ok(card);
  assert.equal(app.querySelectorAll('details.rel-league').length, 2, 'the league card and the cup card');
  assert.equal(app.querySelector('details.rel-league').getAttribute('data-code'), 'PL', 'the cup comes after the leagues');
  assert.equal(text(card.querySelector('.rl-name')), `Champions League (μόνο Elo) δοκιμή σε εγχώριους αγώνες · ${e.n} αγώνες`);
  assert.equal(text(card.querySelector('.rl-skill')), fmtSkill(e.skill.vsBase.rps));
  assert.ok(e.skill.vsBase.rps > 0 && card.querySelector('.rl-skill').classList.contains('neutral'), 'positive skill: no alarm colour, no 8 % claim');
  assert.ok(!card.classList.contains('flagged'));
  assert.deepEqual(summaryParts(card), ['rl-name', 'rl-skill']);
  assert.equal(app.querySelectorAll('.banner.bad').length, 0);
  assert.doesNotMatch(text(app), /Το Champions League δεν ελέγχεται εδώ/, 'the static note is replaced by the card');

  // errors: Elo-only, the league model, the base rates
  const [errors, skill] = card.querySelectorAll('table.rel-t');
  const rows = [...errors.querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(rows.length, 3);
  const quad = (m) => `${fmtDec(m.x12.rps)} ${fmtDec(m.x12.logLoss)} ${fmtDec(m.ou25.logLoss)} ${fmtDec(m.btts.logLoss)}`;
  assert.ok(rows[0].startsWith('Μοντέλο μόνο-Elo') && rows[0].includes(quad(e.metrics.model)), rows[0]);
  assert.ok(rows[1].startsWith('Πλήρες μοντέλο λίγκας') && rows[1].includes(quad(e.leagueModel.metrics)), rows[1]);
  assert.ok(rows[2].startsWith('Βασικές συχνότητες') && rows[2].includes(quad(e.metrics.base)), rows[2]);
  assert.ok(errors.querySelector('tbody tr').classList.contains('me'));

  // improvements: against the base rates, against the league model (negative: the Elo-only model knows less), large gaps
  const sk = [...skill.querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(sk.length, 3);
  const four = (s) => [s.rps, s.logLoss1x2, s.ou25, s.btts].map(fmtSkill).join(' ');
  assert.ok(sk[0].includes(four(e.skill.vsBase)), sk[0]);
  assert.ok(sk[1].includes(four(e.skill.vsLeagueModel)) && e.skill.vsLeagueModel.rps < 0 && /−/.test(sk[1]), sk[1]);
  assert.match(sk[2], new RegExp(`μεγάλες διαφορές Elo \\(≥ ${e.bigGap.threshold} βαθμοί\\)`));
  assert.ok(sk[2].includes(`${e.bigGap.n} αγώνες`) && sk[2].includes(four(e.bigGap.skill.vsBase)), sk[2]);

  // sample and settings
  const tech = text(card.querySelector('dl.tech'));
  assert.ok(tech.includes('Λίγκες στο δείγμα AAA, BBB, CCC'), tech);
  assert.ok(tech.includes(`Αγώνες που βαθμολογήθηκαν ${e.n}`), tech);
  assert.ok(tech.includes(`Εβδομαδιαίες αφετηρίες ${e.origins} (${e.skippedOrigins} παραλείφθηκαν`), tech);
  assert.ok(tech.includes(`Κλίση Elo (κ): πόσο μετράει η διαφορά βαθμολογίας ${dec(e.fit.kappa.mean)} (από ${dec(e.fit.kappa.min)} έως ${dec(e.fit.kappa.max)})`), tech);
  assert.ok(tech.includes(`Πλεονέκτημα έδρας (η) ${dec(e.fit.eta.mean)}`), tech);
  assert.match(text(card), /Δεν ελέγχονται εδώ: το επίπεδο γκολ του ίδιου του Champions League/);
});

test('report: the Champions League card says when last week\'s numbers are shown, and warns when the Elo-only model loses to the base rates', { skip }, async () => {
  const files = healthyReport();
  const e = clone(ELO_ONLY);
  Object.assign(e, { stale: true, staleReason: 'δεν υπάρχουν στιγμιότυπα ClubElo', staleSince: '2026-10-05T03:37:00Z' });
  files['report.json'].eloOnly = e;
  const stale = await boot({ files, hash: '#reliability' });
  const card = stale.doc.querySelector('details.rel-league[data-code="CL"]');
  assert.match(text(card.querySelector('.badges')), /παλιά αποτελέσματα/);
  assert.ok(text(card.querySelector('.rl-body .banner.warn')).includes('δεν υπάρχουν στιγμιότυπα ClubElo'));
  assert.ok(!card.classList.contains('flagged'));

  const bad = healthyReport();
  const w = clone(ELO_ONLY);
  w.skill.vsBase.rps = -0.0234;
  w.flags = [{ code: 'elo-only-below-base', message: 'Το μοντέλο μόνο-Elo (Champions League) είναι χειρότερο από τις βασικές συχνότητες σε εγχώριους αγώνες (−2,3% στο RPS): διάβασε τις πιθανότητες του Champions League με μεγάλη επιφύλαξη.' }];
  bad['report.json'].eloOnly = w;
  const flagged = await boot({ files: bad, hash: '#reliability' });
  const c2 = flagged.doc.querySelector('details.rel-league[data-code="CL"]');
  assert.ok(c2.classList.contains('flagged'));
  assert.ok(c2.querySelector('.rl-skill').classList.contains('bad'));
  assert.equal(text(c2.querySelector('.rl-skill')), fmtSkill(-0.0234));
  assert.match(text(c2.querySelector('.badges')), /κάτω από τις συχνότητες/);
  assert.ok(text(c2.querySelector('.rl-body .banner.warn')).includes('διάβασε τις πιθανότητες του Champions League με μεγάλη επιφύλαξη'));
  assert.deepEqual(summaryParts(c2), ['rl-name', 'rl-skill']);
  // a warning about the cup is not the red "league below the 8 % limit" alarm
  assert.equal(flagged.doc.querySelectorAll('#app > .banner.bad').length, 0);
});

test('report: a cup block with missing or odd pieces renders (dashes, no league model, no large gaps) and hostile text stays text', { skip }, async () => {
  const files = healthyReport();
  const e = clone(ELO_ONLY);
  delete e.leagueModel;
  delete e.skill.vsLeagueModel;
  e.bigGap = null;
  e.fit = { kappa: { mean: 'x' }, eta: null };
  e.unrated = 12;
  e.leagues = ['<img src=x onerror=alert(1)>', 7];
  e.flags = [{ code: 'x', message: '<b onmouseover=alert(3)>hi</b>' }, null, { code: 'y' }];
  e.metrics.model.ou25 = { logLoss: null };
  files['report.json'].eloOnly = e;
  const { doc } = await boot({ files, hash: '#reliability' });
  const card = doc.querySelector('details.rel-league[data-code="CL"]');
  assert.ok(card);
  const [errors, skill] = card.querySelectorAll('table.rel-t');
  const rows = [...errors.querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(rows.length, 2, 'model and base rates only');
  assert.ok(/Μοντέλο μόνο-Elo .* – /.test(rows[0]), rows[0]);
  assert.equal(skill.querySelectorAll('tbody tr').length, 1);
  const tech = text(card.querySelector('dl.tech'));
  assert.ok(tech.includes('Λίγκες στο δείγμα <img src=x onerror=alert(1)>'), tech);
  assert.ok(tech.includes('Αγώνες χωρίς βαθμολογία Elo και για τις δύο ομάδες 12'));
  assert.ok(!tech.includes('Κλίση Elo'), 'an unreadable slope is left out, not shown as NaN');
  assert.ok(text(card.querySelector('.rl-body .banner.warn')).includes('<b onmouseover=alert(3)>hi</b>'));
  assert.equal(card.querySelectorAll('img, b, iframe, script').length, 0, 'nothing from the data file became markup');
  assert.equal(card.querySelectorAll('.banner.warn').length, 1, 'only the flag with a message is shown');

  // an unusable block (no metrics) is ignored: the old static note comes back
  const none = healthyReport();
  none['report.json'].eloOnly = { skipped: 'x' };
  const plain = await boot({ files: none, hash: '#reliability' });
  assert.equal(plain.doc.querySelector('details.rel-league[data-code="CL"]'), null);
  assert.match(text(plain.doc.getElementById('app')), /Το Champions League δεν ελέγχεται εδώ/);
  const odd = healthyReport();
  odd['report.json'].eloOnly = 'nonsense';
  const oddBoot = await boot({ files: odd, hash: '#reliability' });
  assert.equal(oddBoot.doc.querySelector('details.rel-league[data-code="CL"]'), null);
});

test('report: an old report (the weekly job stopped) is called out', { skip }, async () => {
  const files = healthyReport();
  files['report.json'].generatedAt = '2026-09-20T03:37:00Z'; // 28 days before the test clock
  const { doc } = await boot({ files, hash: '#reliability' });
  assert.match(text(doc.querySelector('#app .banner.warn')), /Ο εβδομαδιαίος έλεγχος δεν έχει ανανεωθεί εδώ και 28 ημέρες/);
});

test('report: missing, unreachable, broken or newer files give a clear message with a working retry', { skip }, async () => {
  // 404: the weekly job has never run
  const none = clone(FILES);
  delete none['report.json'];
  const a = await boot({ files: none, hash: '#reliability' });
  assert.match(text(a.doc.getElementById('app')), /Δεν υπάρχει ακόμα αναφορά αξιοπιστίας/);
  assert.match(text(a.doc.getElementById('app')), /Εβδομαδιαίος έλεγχος αξιοπιστίας/);
  assert.equal(a.doc.querySelectorAll('#app .retry').length, 1);
  // ... then the job runs: retry loads it without reloading the matches
  a.files['report.json'] = FILES['report.json'];
  const callsBefore = a.calls.length;
  a.doc.querySelector('#app .retry').click();
  await settle(a.win);
  assert.match(text(a.doc.getElementById('app')), /Πόσο αξιόπιστες είναι οι πιθανότητες;/);
  assert.deepEqual(a.calls.slice(callsBefore), [REPORT_URL], 'only report.json is requested again');

  // network down
  const net = await boot({ files: { ...clone(FILES), 'report.json': null }, hash: '#reliability' });
  assert.match(text(net.doc.getElementById('app')), /Δεν υπάρχει σύνδεση/);
  assert.equal(net.doc.querySelector('#app .retry').dataset.action, 'retry-report');

  // not the expected shape / newer schema
  const bad = await boot({ files: { ...clone(FILES), 'report.json': { schema: 1 } }, hash: '#reliability' });
  assert.match(text(bad.doc.getElementById('app')), /απρόσμενη μορφή/);
  const newer = await boot({ files: { ...clone(FILES), 'report.json': { schema: 2, leagues: {} } }, hash: '#reliability' });
  assert.match(text(newer.doc.getElementById('app')), /νεότερη μορφή/);

  // the matches view is unaffected by a missing report
  a.doc.querySelector('.view-btn[data-view="matches"]').click();
  await settle(a.win);
  assert.equal(cards(a.doc).length, 9);
});

test('report: leagues with missing pieces still render (older job version, partial file)', { skip }, async () => {
  const files = healthyReport();
  const r = files['report.json'];
  r.leagues.PL = { name: 'Premier League', matches: 760, metrics: { model: { x12: { rps: 0.2 } } }, skill: { vsBase: { rps: 0.126 } } };
  delete r.calibrationLayer;
  delete r.window;
  delete r.elo;
  delete r.warnings;
  const { doc } = await boot({ files, hash: '#reliability' });
  const row = doc.querySelector('details[data-code="PL"]');
  assert.ok(row);
  assert.equal(text(row.querySelector('.rl-skill')), fmtSkill(0.126));
  assert.ok(text(row).includes('–'), 'missing numbers are shown as a dash');
  assert.ok(!/Ημίχρονο και ημίχρονο\/τελικός/.test(text(row)), 'no half-time block in a report of an older job version');
});

test('report: half-time block with odd values (null skill, strings) shows dashes and never breaks the page', { skip }, async () => {
  const files = healthyReport();
  const pl = files['report.json'].leagues.PL;
  pl.htft = { n: 321, model: { ht: { rps: 0.2, logLoss: 'abc' }, htft: {}, over05: { logLoss: null }, over15: { logLoss: 0.6 } }, base: { ht: { rps: 0.21 }, htft: { logLoss: 1.9 }, over05: {}, over15: { logLoss: 0.65 } }, skill: { htRps: null, over15: -0.0123 } };
  const { doc } = await boot({ files, hash: '#reliability' });
  const half = [...doc.querySelectorAll('details[data-code="PL"] section.blk')].find((b) => /Ημίχρονο και ημίχρονο\/τελικός/.test(text(b.querySelector('h4'))));
  assert.ok(half);
  const rows = [...half.querySelectorAll('tbody tr')].map((tr) => text(tr));
  assert.equal(rows.length, 2, 'only rows with a model value are shown');
  assert.ok(rows[0].includes(`${fmtDec(0.2)} ${fmtDec(0.21)} –`), rows[0]);
  assert.ok(rows[1].includes(`${fmtDec(0.6)} ${fmtDec(0.65)} ${fmtSkill(-0.0123)}`), rows[1]);
  // a half-time block without any usable number is dropped altogether
  pl.htft = { n: 5, model: {}, base: {} };
  const empty = await boot({ files, hash: '#reliability' });
  assert.ok(!/Ημίχρονο και ημίχρονο\/τελικός/.test(text(empty.doc.querySelector('details[data-code="PL"]'))));
});

test('analysis tab: Phase 2 rows (xG, Elo prior, bootstrap, calibration, settings) and the AI label with the model name', { skip }, async () => {
  const files = clone(FILES);
  const m = files['PL.json'].matches[0];
  m.analysis = { text: 'Σύντομο σχόλιο χωρίς αριθμούς.', source: 'ai', model: 'openai/gpt-oss-120b' };
  const { doc } = await boot({ files });
  const card = cards(doc)[0];
  card.querySelector('.card-head').click();
  tabButton(card, 'Ανάλυση').click();
  const t = text(card.querySelector('.tp'));
  assert.ok(t.includes('Το κείμενο γράφτηκε από γλωσσικό μοντέλο (openai/gpt-oss-120b)'), t.slice(0, 300));
  const p = files['PL.json'].params;
  assert.ok(t.includes(`Βάρος γκολ έναντι xG-proxy (ω) ${dec(p.om)} (γκολ) + ${dec(1 - p.om)} (xG από σουτ)`), t);
  assert.ok(t.includes(`xG-proxy από σουτ ${dec(p.xg.b1)} ανά σουτ στο στόχο`));
  assert.ok(t.includes(`Elo ως αρχική εκτίμηση (prior) ενεργό (επίθεση ${dec(p.eloPrior.ba)} · άμυνα ${dec(p.eloPrior.bd)}`));
  assert.ok(t.includes(`Εύρη αβεβαιότητας (10–90%) ${p.bootstrap.replicates} επαναλήψεις bootstrap`));
  assert.ok(t.includes('Διόρθωση πιθανοτήτων (βαθμονόμηση) καμία'));
  assert.ok(t.includes('Ρυθμίσεις μοντέλου προεπιλογές'));
  assert.ok(t.includes('Prior σκόρερ (Gamma) a 1,00 · b 12,0 (προεπιλογή)'));

  // a Phase 1 file (none of these fields) still renders
  const old = clone(FILES);
  for (const k of ['om', 'xg', 'eloPrior', 'bootstrap', 'calibration', 'tuned', 'scorerPrior']) delete old['PL.json'].params[k];
  const o = await boot({ files: old });
  const c2 = cards(o.doc)[0];
  c2.querySelector('.card-head').click();
  tabButton(c2, 'Ανάλυση').click();
  const t2 = text(c2.querySelector('.tp'));
  assert.ok(t2.includes('Αυτόματο κείμενο από πρότυπο'));
  assert.ok(!t2.includes('xG-proxy'));
  assert.ok(t2.includes('Διόρθωση χαμηλών σκορ (ρ)'));
});
