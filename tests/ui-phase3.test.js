// Phase 3 in the browser app (jsdom): Champions League, half-time/full-time markets, referee and
// absences. The data are the REAL output of the pipeline on the Phase 3 mock servers (PL + CL, with
// API-Football), so this also guards the contract between the pipeline's JSON and the page.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld3, startMockServer3, NOW3 } from './mock-world3.js';
import { HTFT_LABELS } from '../public/util.js';
import { fmtPct, minus, pctSet } from '../public/util.js';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  /* optional dev dependency */
}
const skip = JSDOM ? false : 'jsdom is not installed (run: npm install)';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OK_CONFIG = { OWNER: 'tester', REPO: 'demo', BRANCH: 'data' };
let FILES = null; // { 'index.json', 'PL.json', 'CL.json' } from the real pipeline
let createApp = null;

if (JSDOM) {
  const server = await startMockServer3(buildWorld3());
  Object.assign(process.env, {
    FD_ORG_BASE: `${server.url}/v4`, FD_CSV_BASE: `${server.url}/mmz4281`, ELO_BASE: server.url, API_FOOTBALL_BASE: `${server.url}/apif`,
    FD_ORG_MIN_INTERVAL_MS: '0', CSV_PAUSE_MS: '0', HTTP_BACKOFF_MS: '0', API_FOOTBALL_MIN_INTERVAL_MS: '0', API_FOOTBALL_RATE_WAIT_MS: '0',
  });
  const { runRefresh } = await import('../src/pipeline/refresh.js');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ui3-out-'));
  const quiet = { log() {}, warn() {}, error() {} };
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: 'test-token', API_FOOTBALL_KEY: 'apif-test' },
    prevDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ui3-prev-')), outDir, aliasesPath: path.join(ROOT, 'aliases.json'), now: NOW3, logger: quiet, only: ['PL', 'CL'],
  });
  assert.equal(res.exitCode, 0);
  await server.close();
  FILES = Object.fromEntries(['index.json', 'PL.json', 'CL.json'].map((f) => [f, JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))]));
  globalThis.window = { __FP_NO_AUTOSTART: true };
  ({ createApp } = await import('../public/app.js'));
  delete globalThis.window;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const dec = (x, n = 2) => x.toFixed(n).replace('.', ',');
const dom = [];
after(() => dom.forEach((d) => d.window.close()));

function fakeFetch(files) {
  return async (url) => {
    const v = files[String(url).split('/').pop()];
    if (v === undefined) return new Response('404: Not Found', { status: 404 });
    return new Response(JSON.stringify(v), { status: 200 });
  };
}

async function boot({ files = clone(FILES), now = NOW3, hash = '' } = {}) {
  const d = new JSDOM(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), { url: `https://example.test/${hash}`, pretendToBeVisual: true });
  dom.push(d);
  const win = d.window;
  win.scrollTo = () => {};
  const app = createApp({ doc: win.document, win, fetchFn: fakeFetch(files), config: OK_CONFIG, nowFn: () => now });
  await app.start();
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (win.document.getElementById('app').getAttribute('aria-busy') !== 'true') break;
  }
  await new Promise((r) => setTimeout(r, 5));
  return { win, doc: win.document, files };
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
const leagueOf = (card) => text(card.querySelector('.meta .lg'));
const cardOf = (doc, home, away) => cards(doc).find((c) => text(c.querySelector('.teams')) === `${home} – ${away}`);

/** Opens the card and selects the tab; returns the text of the panel. */
function openTab(card, label) {
  const head = card.querySelector('.card-head');
  if (head.getAttribute('aria-expanded') !== 'true') head.click();
  [...card.querySelectorAll('.tab')].find((b) => b.textContent === label).click();
  return card.querySelector('.tp');
}
const blockOf = (panel, title) => [...panel.querySelectorAll('section.blk')].find((b) => text(b.querySelector('h4')) === title);

const clMatch = (id, files = FILES) => files['CL.json'].matches.find((m) => m.id === id);

// ------------------------------------------------------------------------------------------------

test('list: the Champions League chip, stage labels, and the "lower confidence" badge only on Champions League cards', { skip }, async () => {
  const { doc } = await boot();
  const chips = [...doc.querySelectorAll('#chips .chip')].map((c) => text(c));
  assert.ok(chips.some((c) => /^Όλες/.test(c)));
  assert.ok(chips.some((c) => /Premier League/.test(c)) && chips.some((c) => /Champions League/.test(c)), chips.join(' | '));
  const all = cards(doc);
  assert.equal(all.length, FILES['PL.json'].matches.length + FILES['CL.json'].matches.length);

  const cl = all.filter((c) => leagueOf(c) === 'Champions League');
  const pl = all.filter((c) => leagueOf(c) === 'Premier League');
  assert.equal(cl.length, 8);
  assert.equal(pl.length, 9);
  for (const c of cl) {
    const pills = [...c.querySelectorAll('.badges .pill')].map((p) => text(p));
    assert.ok(pills.includes('χαμηλότερη βεβαιότητα'), pills.join(' | '));
    assert.equal(c.querySelector('.pill.warn').getAttribute('title').includes('Elo'), true, 'the badge explains itself');
  }
  for (const c of pl) assert.ok(![...c.querySelectorAll('.badges .pill')].some((p) => /χαμηλότερη βεβαιότητα/.test(text(p))));

  // stage and matchday of the league phase; the final is on neutral ground and has no matchday
  const first = cardOf(doc, 'Arsenal', 'Amber Wolves');
  assert.ok(first, 'Arsenal - Amber Wolves is listed');
  const meta = text(first.querySelector('.meta'));
  assert.match(meta, /Φάση λίγκας/);
  assert.match(meta, /Αγ\. 3/);
  const final = cl.find((c) => /Τελικός/.test(text(c.querySelector('.meta'))));
  assert.ok(final, 'the final is labelled');
  assert.match(text(final.querySelector('.meta')), /ουδέτερο γήπεδο/);
  assert.doesNotMatch(text(final.querySelector('.meta')), /Αγ\./);
  // the league filter shows only the Champions League
  const hashDoc = (await boot({ hash: '#CL' })).doc;
  assert.equal(cards(hashDoc).length, 8);
});

test('result tab: half-time result and the nine HT/FT combinations come from the data, in the documented order', { skip }, async () => {
  const { doc } = await boot();
  const m = clMatch(770000);
  const card = cardOf(doc, 'Arsenal', 'Amber Wolves');
  const panel = openTab(card, 'Αποτέλεσμα');
  const ht = blockOf(panel, 'Αποτέλεσμα ημιχρόνου');
  assert.ok(ht, 'half-time block');
  const [ph, pd, pa] = pctSet([m.htft.ht.home, m.htft.ht.draw, m.htft.ht.away]);
  assert.ok(text(ht).includes(`1 · Προηγείται ο Arsenal ${ph}`), text(ht));
  assert.ok(text(ht).includes(`Χ · Ισοπαλία στο ημίχρονο ${pd}`));
  assert.ok(text(ht).includes(`2 · Προηγείται ο Amber Wolves ${pa}`));

  const combos = blockOf(panel, 'Ημίχρονο / Τελικό');
  assert.ok(combos, 'HT/FT block');
  const shown = pctSet(m.htft.combos);
  const rows = [...combos.querySelectorAll('.row')].map((r) => text(r));
  assert.equal(rows.length, 9);
  rows.forEach((r, i) => assert.ok(r.startsWith(`${HTFT_LABELS[i]} ${shown[i]}`), `${i}: ${r}`));
  assert.match(text(combos), /οι ανατροπές .* υποεκτιμώνται/);
  // the displayed percentages of the nine combinations add up to 100
  assert.equal(shown.map((s) => Number.parseInt(s, 10)).reduce((a, b) => a + b, 0), 100);
  // the half-time block sits between the correct scores and the handicaps
  const titles = [...panel.querySelectorAll('section.blk > h4')].map((h) => text(h));
  assert.ok(titles.indexOf('Ημίχρονο / Τελικό') > titles.findIndex((t) => /Πιθανότερα σκορ/.test(t)));
  assert.ok(titles.indexOf('Ημίχρονο / Τελικό') < titles.findIndex((t) => /Χάντικαπ/.test(t)));

  // the same blocks exist for a Premier League match
  const plCard = cards(doc).find((c) => leagueOf(c) === 'Premier League');
  const plPanel = openTab(plCard, 'Αποτέλεσμα');
  assert.ok(blockOf(plPanel, 'Ημίχρονο / Τελικό'));
});

test('goals tab: first-half goals with the share of goals of the league', { skip }, async () => {
  const { doc } = await boot();
  const m = clMatch(770000);
  const panel = openTab(cardOf(doc, 'Arsenal', 'Amber Wolves'), 'Γκολ');
  const fh = blockOf(panel, "Γκολ α' ημιχρόνου");
  assert.ok(fh, 'first-half block');
  assert.ok(text(fh).includes(`Αναμενόμενα ${dec(m.htft.firstHalf.mean)}`), text(fh));
  assert.ok(text(fh).includes(`Μερίδιο γκολ ${Math.round(m.htft.s * 100)}%`));
  for (const t of m.htft.firstHalf.totals) {
    const [over, under] = pctSet([t.over, t.under]);
    assert.ok(text(fh).includes(`${dec(t.line, 1)} γκολ Over ${over} Under ${under}`), `${t.line}: ${text(fh)}`);
  }
});

test('Champions League: corners and cards are explained, not faked; the Premier League keeps both', { skip }, async () => {
  const { doc } = await boot();
  const cl = cardOf(doc, 'Arsenal', 'Amber Wolves');
  assert.match(text(openTab(cl, 'Κόρνερ')), /Στο Champions League δεν υπάρχουν κόρνερ/);
  assert.match(text(openTab(cl, 'Κάρτες')), /Στο Champions League δεν υπάρχουν κάρτες/);
  const pl = cardOf(doc, 'Arsenal', 'Chelsea');
  assert.match(text(openTab(pl, 'Κόρνερ')), /Αναμενόμενα κόρνερ/);
  assert.match(text(openTab(pl, 'Κάρτες')), /Αναμενόμενες κάρτες/);
});

test('referee: the name, his number of matches and the source when it is API-Football', { skip }, async () => {
  const { doc } = await boot();
  // football-data.org knows the referee of Arsenal - Chelsea: no source label
  const ac = FILES['PL.json'].matches.find((m) => m.homeName === 'Arsenal' && m.awayName === 'Chelsea');
  assert.equal(ac.cards.referee.source, 'football-data.org');
  const t1 = text(openTab(cardOf(doc, 'Arsenal', 'Chelsea'), 'Κάρτες'));
  assert.ok(t1.includes(`Διαιτητής: ${ac.cards.referee.name} · ${ac.cards.referee.matches} αγώνες στη βάση`), t1.slice(0, 500));
  assert.ok(!t1.includes('πηγή: API-Football'));
  // Liverpool - Man City: only API-Football names him
  const lm = FILES['PL.json'].matches.find((m) => m.homeName === 'Liverpool' && m.awayName === 'Man City');
  assert.equal(lm.cards.referee.source, 'api-football');
  const t2 = text(openTab(cardOf(doc, 'Liverpool', 'Man City'), 'Κάρτες'));
  assert.ok(t2.includes(`Διαιτητής: ${lm.cards.referee.name} (πηγή: API-Football) · ${lm.cards.referee.matches} αγώνες στη βάση`), t2.slice(0, 500));
  const f = lm.cards.refereeFactor;
  if (Math.abs(f - 1) > 0.005) assert.ok(t2.includes(`συντελεστής ×${dec(f)}`));
  else assert.match(t2, /κοντά στον μέσο όρο, χωρίς διόρθωση/);
});

test('scorers tab: absent players are listed apart, doubtful ones stay in the table with a warning', { skip }, async () => {
  const { doc } = await boot();
  const m0 = clMatch(770000);
  const panel = openTab(cardOf(doc, 'Arsenal', 'Amber Wolves'), 'Σκόρερ');
  assert.match(text(panel), /API-Football/, 'the note about absences replaces the "no line-ups" note');
  const abs = blockOf(panel, 'Απουσίες (API-Football)');
  assert.ok(abs);
  // the team name is bold and the list follows in the same item (the text helper separates the text nodes with a space)
  assert.ok(text(abs).includes('Arsenal : Arsenal Striker (τραυματισμός)'), text(abs));
  assert.ok(!/Amber Wolves :/.test(text(abs)), 'no entry for a team without absences');
  const tables = [...panel.querySelectorAll('table.sc')];
  assert.equal(tables.length, 2);
  assert.ok(!text(tables[0]).includes('Arsenal Striker'), 'the absent player is not in the probability table');
  const doubtful = m0.scorers.away.find((p) => p.doubtful);
  const doubtRow = [...tables[1].querySelectorAll('tbody tr')].find((tr) => text(tr.querySelector('.pn')) === doubtful.name);
  assert.ok(doubtRow, 'the doubtful player is still listed');
  assert.equal(text(doubtRow.querySelector('small.doubt')), 'αμφίβολος (τραυματισμός)');
  assert.ok(text(doubtRow).includes(fmtPct(doubtful.anytime)));
  assert.ok(![...tables[1].querySelectorAll('tbody tr')].filter((tr) => tr !== doubtRow).some((tr) => tr.querySelector('.doubt')));

  // a suspension is worded as such
  const m1 = clMatch(770001);
  const t1 = openTab(cardOf(doc, m1.homeName, m1.awayName), 'Σκόρερ');
  assert.ok(text(blockOf(t1, 'Απουσίες (API-Football)')).includes('Man City Striker (τιμωρία)'));

  // a match for which no injury list was requested has no such block
  const m3 = clMatch(770003);
  const t3 = openTab(cardOf(doc, m3.homeName, m3.awayName), 'Σκόρερ');
  assert.equal(blockOf(t3, 'Απουσίες (API-Football)'), undefined);
});

test('analysis tab (Champions League): Elo-only model rows and the explanation of the badge', { skip }, async () => {
  const { doc } = await boot();
  const e = FILES['CL.json'].params.eloOnly;
  const regular = openTab(cardOf(doc, 'Arsenal', 'Amber Wolves'), 'Ανάλυση');
  const tech = text(regular.querySelector('dl.tech'));
  assert.ok(tech.includes(`Κλίση Elo (κ) ${dec(e.kappa)} ± ${dec(e.kappaSe)}`), tech);
  assert.ok(tech.includes(`Πλεονέκτημα έδρας (μοντέλο Elo) ${minus(dec(e.eta, 3))}`));
  assert.ok(tech.includes(`Εγχώριοι αγώνες για την κλίση ${e.pooledMatches}`));
  assert.ok(tech.includes(`Αγώνες Champions League για το επίπεδο γκολ ${e.cupMatches} (βάρος ${Math.round(e.cupWeight * 100)}%)`));
  assert.ok(tech.includes(`Μερίδιο γκολ στο α' ημίχρονο ${Math.round(FILES['CL.json'].params.halfShare.s * 100)}%`));
  assert.match(text(regular), /χαμηλότερη βεβαιότητα — Στο Champions League οι ομάδες δεν έχουν κοινό ιστορικό/);
  assert.match(text(regular), /βαθμολογία Elo/);
  assert.match(text(regular.querySelector('.analysis')), /Elo/);

  // the final: no home advantage
  const fin = FILES['CL.json'].matches.find((m) => m.stage === 'FINAL');
  const finTech = text(openTab(cardOf(doc, fin.homeName, fin.awayName), 'Ανάλυση').querySelector('dl.tech'));
  assert.ok(finTech.includes('Πλεονέκτημα έδρας 0 (ουδέτερο γήπεδο)'), finTech);
});

test('footer: the API-Football credit, the note on absences and the Champions League note appear with this data', { skip }, async () => {
  const { doc } = await boot();
  assert.equal(FILES['index.json'].sources.apiFootball.status, 'ok');
  for (const id of ['credit-apif', 'foot-absences', 'foot-cl']) assert.equal(doc.getElementById(id).hidden, false, id);
  assert.match(text(doc.getElementById('foot-cl')), /Champions League: το μοντέλο βλέπει μόνο τη βαθμολογία Elo/);
  const hosts = [...doc.querySelectorAll('footer a')].filter((a) => !a.closest('[hidden]')).map((a) => new URL(a.href).hostname);
  assert.deepEqual(hosts, ['www.football-data.co.uk', 'clubelo.com', 'www.api-football.com', 'www.football-data.org']);
});

test('data files of earlier phases (no htft, absences, stage or eloOnly flag) show none of the new blocks and do not break', { skip }, async () => {
  const files = clone(FILES);
  for (const f of ['PL.json', 'CL.json']) {
    for (const m of files[f].matches) {
      delete m.htft;
      if (m.scorers) delete m.scorers.absences;
      delete m.stage;
      delete m.neutral;
      delete m.flags?.eloOnly;
    }
  }
  delete files['index.json'].sources;
  for (const l of files['index.json'].leagues) delete l.eloOnly;
  const { doc } = await boot({ files });
  assert.equal(cards(doc).length, FILES['PL.json'].matches.length + FILES['CL.json'].matches.length);
  assert.ok(![...doc.querySelectorAll('.pill')].some((p) => /χαμηλότερη βεβαιότητα/.test(text(p))));
  assert.ok(![...doc.querySelectorAll('.meta .md')].some((p) => /Φάση λίγκας|Τελικός|ουδέτερο/.test(text(p))));
  for (const id of ['credit-apif', 'foot-absences', 'foot-cl']) assert.equal(doc.getElementById(id).hidden, true, id);
  const card = cardOf(doc, 'Arsenal', 'Amber Wolves');
  assert.equal(blockOf(openTab(card, 'Αποτέλεσμα'), 'Ημίχρονο / Τελικό'), undefined);
  assert.equal(blockOf(openTab(card, 'Γκολ'), "Γκολ α' ημιχρόνου"), undefined);
  assert.equal(blockOf(openTab(card, 'Σκόρερ'), 'Απουσίες (API-Football)'), undefined);
  // an htft block with the wrong shape is ignored as well
  const odd = clone(FILES);
  odd['CL.json'].matches[0].htft = { s: 0.44, ht: { home: 0.3 }, combos: [0.1, 0.2], firstHalf: { mean: 'x', totals: 5 } };
  const o = await boot({ files: odd });
  const oc = cardOf(o.doc, 'Arsenal', 'Amber Wolves');
  assert.equal(blockOf(openTab(oc, 'Αποτέλεσμα'), 'Ημίχρονο / Τελικό'), undefined);
  assert.equal(blockOf(openTab(oc, 'Γκολ'), "Γκολ α' ημιχρόνου"), undefined);
});

test('external text of the new fields (referee, absent players, stage) is never interpreted as HTML', { skip }, async () => {
  const files = clone(FILES);
  const evil = '<img src=x onerror="globalThis.hacked=1">';
  const ac = files['PL.json'].matches.find((m) => m.homeName === 'Arsenal' && m.awayName === 'Chelsea');
  ac.cards.referee.name = evil;
  const m0 = files['CL.json'].matches.find((m) => m.id === 770000);
  m0.scorers.absences.home[0].name = evil;
  m0.scorers.away.find((p) => p.doubtful).kind = evil;
  m0.stage = evil;
  const { doc, win } = await boot({ files });
  const plPanel = openTab(cardOf(doc, 'Arsenal', 'Chelsea'), 'Κάρτες');
  assert.ok(text(plPanel).includes(`Διαιτητής: ${evil}`));
  const clPanel = openTab(cardOf(doc, 'Arsenal', 'Amber Wolves'), 'Σκόρερ');
  assert.ok(text(blockOf(clPanel, 'Απουσίες (API-Football)')).includes(`${evil} (τραυματισμός)`));
  assert.ok(text(clPanel.querySelector('small.doubt')).includes('αμφίβολος (απουσία)'), 'an unknown reason kind is shown as a plain absence');
  assert.equal(doc.querySelectorAll('article img, article script').length, 0);
  assert.equal(win.hacked, undefined);
  assert.doesNotMatch(text(cardOf(doc, 'Arsenal', 'Amber Wolves').querySelector('.meta')), /<img/, 'an unknown stage code is not shown at all');
});
