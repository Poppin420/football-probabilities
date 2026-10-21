// DOM builders for the match card and its six tabs.
// Only createElement / textContent are used (never innerHTML): team and player
// names come from external sources and must never be interpreted as HTML.

import { num } from './format.js';
import {
  fmtPct, pctSet, lineText, minus, signed, rangeText, rangeOf, matchBadges, formatTime, formatStamp, ageHours, agoText,
  stageLabel, absenceKindText, HTFT_LABELS, htftOf,
} from './util.js';

export const TABS = [
  ['result', 'Αποτέλεσμα'],
  ['goals', 'Γκολ'],
  ['corners', 'Κόρνερ'],
  ['cards', 'Κάρτες'],
  ['scorers', 'Σκόρερ'],
  ['analysis', 'Ανάλυση'],
];

const DASH = '–';

export function makeH(doc) {
  function append(node, kids) {
    for (const kid of kids) {
      if (Array.isArray(kid)) append(node, kid);
      else if (kid === null || kid === undefined || kid === false) continue;
      else node.append(typeof kid === 'object' ? kid : String(kid));
    }
  }
  return function h(tag, props, ...kids) {
    const node = doc.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'width') node.style.width = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(node, kids);
    return node;
  };
}

export const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

export function createViews(h) {
  // ------------------------------------------------------------ primitives --
  const clamp01 = (p) => (Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0);
  const barOf = (p, cls = '') =>
    h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { class: cls, width: `${(clamp01(p) * 100).toFixed(1)}%` }));
  const block = (title, ...kids) => h('section', { class: 'blk' }, title ? h('h4', null, title) : null, kids);
  const empty = (text) => h('p', { class: 'empty' }, text);
  const note = (text) => h('p', { class: 'note' }, text);

  /** One probability: label, value, optional 10-90% range, bar. */
  function row(label, p, { cls = '', shown = null, range = null, strong = false } = {}) {
    const rt = rangeText(range);
    return h(
      'div',
      { class: `row${strong ? ' strong' : ''}` },
      h('span', { class: 'lbl' }, label),
      h('span', { class: 'val' }, shown ?? fmtPct(p), rt ? h('small', { class: 'rng', title: 'Εύρος 10%–90% λόγω αβεβαιότητας του μοντέλου' }, ` (${rt})`) : null),
      barOf(p, cls),
    );
  }

  /** Complementary outcomes (Over/Under, Yes/No, win/push/lose): percentages sum to 100. */
  function multi(label, parts, { strong = false, range = null } = {}) {
    const shown = pctSet(parts.map((x) => x.p));
    const best = parts.reduce((bi, x, i) => (x.p > parts[bi].p ? i : bi), 0);
    const rt = rangeText(range);
    return h(
      'div',
      { class: `row multi${strong ? ' strong' : ''}` },
      h('span', { class: 'lbl' }, label),
      h(
        'span',
        { class: 'val' },
        parts.map((x, i) => h('span', { class: i === best ? 'lead' : '' }, `${x.name} ${shown[i]}`)),
        rt ? h('small', { class: 'rng' }, ` (${rt})`) : null,
      ),
      barOf(parts[0].p),
    );
  }

  const overUnder = (label, t, opts) => multi(label, [{ name: 'Over', p: t.over }, { name: 'Under', p: t.under }], opts);
  const stats = (pairs) =>
    h('p', { class: 'stats' }, pairs.map(([l, v]) => h('span', { class: 'stat' }, h('small', null, l), h('b', null, v))));

  /** Half-time result and the nine HT/FT combinations (absent in data files of earlier phases). */
  function htftBlocks(m) {
    const b = htftOf(m);
    if (!b) return null;
    const hn = m.homeName;
    const an = m.awayName;
    const [ph, pd, pa] = pctSet([b.ht.home, b.ht.draw, b.ht.away]);
    const shown = pctSet(b.combos);
    return [
      block(
        'Αποτέλεσμα ημιχρόνου',
        row(`1 · Προηγείται ο ${hn}`, b.ht.home, { cls: 'home', shown: ph }),
        row('Χ · Ισοπαλία στο ημίχρονο', b.ht.draw, { cls: 'draw', shown: pd }),
        row(`2 · Προηγείται ο ${an}`, b.ht.away, { cls: 'away', shown: pa }),
      ),
      block(
        'Ημίχρονο / Τελικό',
        b.combos.map((p, i) => row(HTFT_LABELS[i], p, { shown: shown[i], cls: i % 4 === 0 ? (i === 0 ? 'home' : 'away') : i === 4 ? 'draw' : '' })),
        note(`Πρώτο σύμβολο: αποτέλεσμα στο ημίχρονο, δεύτερο: στο τέλος (1 = ${hn}, Χ = ισοπαλία, 2 = ${an}). Το τελικό αποτέλεσμα είναι πάντα ίδιο με το 1Χ2 παραπάνω· οι ανατροπές (π.χ. 1/2, 2/1) υποεκτιμώνται ελαφρά.`),
      ),
    ];
  }

  /** First-half goals (Over/Under) for the goals tab. */
  function firstHalfBlock(m) {
    const b = htftOf(m);
    const fh = b?.firstHalf;
    if (!fh || !Array.isArray(fh.totals) || fh.totals.length === 0 || !Number.isFinite(fh.mean)) return null;
    return block(
      'Γκολ α\' ημιχρόνου',
      stats([['Αναμενόμενα', num(fh.mean, 2)], ['Μερίδιο γκολ', `${Math.round((b.s ?? 0) * 100)}%`]]),
      fh.totals.map((t) => overUnder(`${lineText(t.line)} γκολ`, t)),
    );
  }

  // ----------------------------------------------------------------- tabs --
  function resultTab({ m }) {
    const g = m.goals;
    const hn = m.homeName;
    const an = m.awayName;
    const x = g.oneX2;
    const [ph, pd, pa] = pctSet([x.home, x.draw, x.away]);
    const dc = g.doubleChance;
    const [dnbHome, dnbAway] = pctSet([g.drawNoBet.home, g.drawNoBet.away]);
    return [
      block(
        'Τελικό αποτέλεσμα (1Χ2)',
        row(`1 · Νίκη ${hn}`, x.home, { cls: 'home', shown: ph, range: rangeOf(m, 'oneX2.home') }),
        row('Χ · Ισοπαλία', x.draw, { cls: 'draw', shown: pd, range: rangeOf(m, 'oneX2.draw') }),
        row(`2 · Νίκη ${an}`, x.away, { cls: 'away', shown: pa, range: rangeOf(m, 'oneX2.away') }),
      ),
      block(
        'Διπλή ευκαιρία',
        row(`1Χ · ${hn} ή ισοπαλία`, dc.homeDraw),
        row('12 · Κερδίζει κάποια ομάδα', dc.homeAway),
        row(`Χ2 · Ισοπαλία ή ${an}`, dc.drawAway),
      ),
      block(
        'Χωρίς ισοπαλία (DNB)',
        row(hn, g.drawNoBet.home, { cls: 'home', shown: dnbHome }),
        row(an, g.drawNoBet.away, { cls: 'away', shown: dnbAway }),
        note(`Σε ισοπαλία (${fmtPct(g.drawNoBet.push)}) η αγορά ακυρώνεται.`),
      ),
      block(
        'Πιθανότερα σκορ (γηπεδούχος – φιλοξενούμενος)',
        h(
          'div',
          { class: 'scores' },
          g.correctScores.map((s) => h('div', { class: 'score' }, h('b', null, `${s.home}${DASH}${s.away}`), h('span', null, fmtPct(s.p)))),
        ),
        note(`Όλα τα υπόλοιπα σκορ μαζί: ${fmtPct(g.correctScoresOther)}.`),
      ),
      htftBlocks(m),
      block(
        `Χάντικαπ για την ομάδα ${hn}`,
        g.handicaps.map((hc) =>
          multi(
            `${hn} ${signed(hc.line)}`,
            hc.push > 0.0005
              ? [{ name: 'Κερδίζει', p: hc.win }, { name: 'Επιστροφή', p: hc.push }, { name: 'Χάνει', p: hc.lose }]
              : [{ name: 'Κερδίζει', p: hc.win }, { name: 'Χάνει', p: hc.lose }],
          ),
        ),
      ),
    ];
  }

  function goalsTab({ m }) {
    const g = m.goals;
    const hn = m.homeName;
    const an = m.awayName;
    const b = g.bttsOver25;
    const shownB = pctSet([b.yesOver, b.yesUnder, b.noOver, b.noUnder]);
    const shownExact = pctSet(g.exactTotals);
    const e = g.expected;
    return [
      block('Αναμενόμενα γκολ (xG του μοντέλου)', stats([[hn, num(e.home, 2)], [an, num(e.away, 2)], ['Σύνολο', num(e.total, 2)]])),
      block(
        'Σύνολο γκολ (Over / Under)',
        g.totals.map((t) =>
          overUnder(`${lineText(t.line)} γκολ`, t, { strong: t.line === 2.5, range: t.line === 2.5 ? rangeOf(m, 'over25') : null }),
        ),
      ),
      firstHalfBlock(m),
      block(
        'Σκοράρουν και οι δύο ομάδες (GG)',
        multi('GG', [{ name: 'Ναι', p: g.btts.yes }, { name: 'Όχι', p: g.btts.no }], { strong: true, range: rangeOf(m, 'btts') }),
        row('GG & Over 2,5', b.yesOver, { shown: shownB[0] }),
        row('GG & Under 2,5', b.yesUnder, { shown: shownB[1] }),
        row('Όχι GG & Over 2,5', b.noOver, { shown: shownB[2] }),
        row('Όχι GG & Under 2,5', b.noUnder, { shown: shownB[3] }),
      ),
      block(
        'Ακριβές σύνολο γκολ',
        g.exactTotals.map((p, i) => row(i === g.exactTotals.length - 1 ? `${i}+ γκολ` : `${i} γκολ`, p, { shown: shownExact[i] })),
      ),
      block(`Γκολ της ομάδας ${hn}`, g.teamTotals.home.map((t) => overUnder(`${lineText(t.line)} γκολ`, t))),
      block(`Γκολ της ομάδας ${an}`, g.teamTotals.away.map((t) => overUnder(`${lineText(t.line)} γκολ`, t))),
      block(
        'Άλλες αγορές',
        row(`Μηδέν παθητικό: ${hn}`, g.cleanSheet.home),
        row(`Μηδέν παθητικό: ${an}`, g.cleanSheet.away),
        row(`Νίκη ${hn} χωρίς παθητικό`, g.winToNil.home),
        row(`Νίκη ${an} χωρίς παθητικό`, g.winToNil.away),
        multi('Σύνολο γκολ', [{ name: 'Μονό', p: g.oddEven.odd }, { name: 'Ζυγό', p: g.oddEven.even }]),
      ),
    ];
  }

  const closestLine = (list, target) => list.reduce((best, t) => (Math.abs(t.line - target) < Math.abs(best.line - target) ? t : best), list[0]);

  function cornersTab({ m }) {
    const c = m.corners;
    if (!c && m.flags?.eloOnly) return [empty('Στο Champions League δεν υπάρχουν κόρνερ: οι ομάδες δεν έχουν κοινό ιστορικό και το μοντέλο βλέπει μόνο τη βαθμολογία Elo.')];
    if (!c) return [empty('Δεν υπάρχουν αρκετά δεδομένα για κόρνερ σε αυτό το πρωτάθλημα.')];
    const hn = m.homeName;
    const an = m.awayName;
    const mid = closestLine(c.totals, c.mean.total);
    return [
      block('Αναμενόμενα κόρνερ', stats([[hn, num(c.mean.home, 1)], [an, num(c.mean.away, 1)], ['Σύνολο', num(c.mean.total, 1)]])),
      block('Σύνολο κόρνερ (Over / Under)', c.totals.map((t) => overUnder(`${lineText(t.line)} κόρνερ`, t, { strong: t === mid }))),
      block(
        'Ποια ομάδα κερδίζει τα περισσότερα κόρνερ',
        multi('Περισσότερα κόρνερ', [{ name: hn, p: c.more.home }, { name: 'Ίσα', p: c.more.equal }, { name: an, p: c.more.away }]),
      ),
      block(`Κόρνερ της ομάδας ${hn}`, c.teamTotals.home.map((t) => overUnder(`${lineText(t.line)} κόρνερ`, t))),
      block(`Κόρνερ της ομάδας ${an}`, c.teamTotals.away.map((t) => overUnder(`${lineText(t.line)} κόρνερ`, t))),
      block(
        `Χάντικαπ κόρνερ για την ομάδα ${hn}`,
        c.handicaps.map((hc) => multi(`${hn} ${signed(hc.line)}`, [{ name: 'Κερδίζει', p: hc.win }, { name: 'Χάνει', p: hc.lose }])),
      ),
    ];
  }

  /** The referee line of the cards tab: name, how many of his matches are in the data, and the factor when it applies. */
  function refereeNote(c, f) {
    const r = c.referee;
    const factor = typeof f === 'number' && Math.abs(f - 1) > 0.005 ? f : null;
    if (r && typeof r.name === 'string' && r.name) {
      const from = r.source === 'api-football' ? ' (πηγή: API-Football)' : '';
      if (factor !== null) {
        return note(`Διαιτητής: ${r.name}${from} · ${r.matches} αγώνες στη βάση · συντελεστής ×${num(factor, 2)} (${factor > 1 ? 'πιο αυστηρός' : 'πιο επιεικής'} από τον μέσο όρο).`);
      }
      if (r.matches < 5) return note(`Διαιτητής: ${r.name}${from} · ${r.matches === 0 ? 'δεν υπάρχει στη βάση' : `μόνο ${r.matches} αγώνες στη βάση`}, άρα δεν επηρεάζει τις κάρτες (χρειάζονται τουλάχιστον 5).`);
      return note(`Διαιτητής: ${r.name}${from} · ${r.matches} αγώνες στη βάση · κοντά στον μέσο όρο, χωρίς διόρθωση.`);
    }
    return factor !== null ? note(`Διαιτητής: συντελεστής ×${num(factor, 2)} (${factor > 1 ? 'πιο αυστηρός' : 'πιο επιεικής'} από τον μέσο όρο).`) : null;
  }

  function cardsTab({ m }) {
    const c = m.cards;
    if (!c && m.flags?.eloOnly) return [empty('Στο Champions League δεν υπάρχουν κάρτες: οι ομάδες δεν έχουν κοινό ιστορικό και το μοντέλο βλέπει μόνο τη βαθμολογία Elo.')];
    if (!c) return [empty('Δεν υπάρχουν αρκετά δεδομένα για κάρτες σε αυτό το πρωτάθλημα.')];
    const hn = m.homeName;
    const an = m.awayName;
    const mid = closestLine(c.totals, c.mean.total);
    const f = c.refereeFactor;
    return [
      block(
        'Αναμενόμενες κάρτες',
        stats([
          ['Σύνολο', num(c.mean.total, 1)],
          [`Κίτρινες ${hn}`, num(c.mean.yellowHome, 1)],
          [`Κίτρινες ${an}`, num(c.mean.yellowAway, 1)],
          ['Κόκκινες (και οι δύο)', num(c.mean.redHome + c.mean.redAway, 2)],
        ]),
        refereeNote(c, f),
      ),
      block('Σύνολο καρτών (Over / Under)', c.totals.map((t) => overUnder(`${lineText(t.line)} κάρτες`, t, { strong: t === mid }))),
      c.bookingPoints && c.bookingPoints.length
        ? block(
            'Πόντοι κράτησης (κίτρινη = 10, κόκκινη = 25)',
            c.bookingPoints.map((t) => overUnder(`${lineText(t.line)} πόντοι`, t)),
          )
        : null,
    ];
  }

  function scorersTab({ m, league }) {
    if (!m.scorers) return [empty('Δεν υπάρχουν δεδομένα σκόρερ για αυτόν τον αγώνα.')];
    const abs = m.scorers.absences;
    const info = (abs && league.notes?.scorersAbsences) || league.notes?.scorers || 'Δεν υπάρχουν συνθέσεις: οι πιθανότητες δεν λαμβάνουν υπόψη αν ο παίκτης θα παίξει.';
    const table = (title, list) =>
      block(
        title,
        list.length === 0
          ? empty('Δεν βρέθηκαν σκόρερ για την ομάδα.')
          : h(
              'table',
              { class: 'sc' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { scope: 'col' }, 'Παίκτης'),
                  h('th', { scope: 'col', title: 'Σκοράρει τουλάχιστον ένα γκολ' }, 'Σκοράρει'),
                  h('th', { scope: 'col', title: 'Σκοράρει δύο ή περισσότερα γκολ' }, '2+'),
                  h('th', { scope: 'col', title: 'Σκοράρει το πρώτο γκολ του αγώνα' }, 'Πρώτος'),
                ),
              ),
              h(
                'tbody',
                null,
                list.map((p) =>
                  h(
                    'tr',
                    null,
                    h(
                      'th',
                      { scope: 'row' },
                      h('span', { class: 'pn' }, p.name),
                      h('small', null, `${p.goals} γκολ φέτος`),
                      p.doubtful ? h('small', { class: 'doubt', title: 'Το API-Football τον δείχνει αμφίβολο· δεν αφαιρείται από τη λίστα.' }, `αμφίβολος (${absenceKindText(p.kind)})`) : null,
                    ),
                    h('td', null, h('b', null, fmtPct(p.anytime))),
                    h('td', null, fmtPct(p.twoPlus)),
                    h('td', null, fmtPct(p.first)),
                  ),
                ),
              ),
            ),
      );
    return [
      note(info),
      table(m.homeName, m.scorers.home || []),
      table(m.awayName, m.scorers.away || []),
      absenceBlock(m, abs),
    ];
  }

  /** Players left out of the list because the API-Football says they will miss the match. */
  function absenceBlock(m, abs) {
    if (!abs) return null;
    const side = (name, list) => (Array.isArray(list) && list.length > 0 ? h('li', null, h('b', null, name), `: ${list.map((p) => `${p.name} (${absenceKindText(p.kind)})`).join(', ')}`) : null);
    const items = [side(m.homeName, abs.home), side(m.awayName, abs.away)].filter(Boolean);
    return block(
      'Απουσίες (API-Football)',
      items.length > 0 ? h('ul', { class: 'help' }, items) : empty('Δεν αναφέρονται απουσίες γνωστών σκόρερ.'),
      note('Οι παίκτες αυτοί έχουν αφαιρεθεί από τη λίστα και οι πιθανότητες των υπολοίπων έχουν υπολογιστεί χωρίς αυτούς.'),
    );
  }

  /** Phase 2 technical rows: only the pieces the data file actually carries (Phase 1 files have none). */
  function phase2Rows(params) {
    const rows = [];
    if (Number.isFinite(params.om)) {
      rows.push(['Βάρος γκολ έναντι xG-proxy (ω)', params.om >= 1 ? '1,00 (μόνο πραγματικά γκολ)' : `${num(params.om, 2)} (γκολ) + ${num(1 - params.om, 2)} (xG από σουτ)`]);
    }
    const xg = params.xg;
    if (xg && Number.isFinite(xg.b1) && Number.isFinite(xg.b2)) {
      rows.push(['xG-proxy από σουτ', `${num(xg.b1, 2)} ανά σουτ στο στόχο · ${num(xg.b2, 2)} ανά άλλο σουτ`]);
    }
    const ep = params.eloPrior;
    if (ep && typeof ep === 'object') {
      rows.push([
        'Elo ως αρχική εκτίμηση (prior)',
        ep.on
          ? `ενεργό (επίθεση ${num(ep.ba, 2)} · άμυνα ${num(ep.bd, 2)}${Number.isFinite(ep.coverage) ? ` · κάλυψη ${Math.round(ep.coverage * 100)}%` : ''})`
          : 'ανενεργό',
      ]);
    }
    const bs = params.bootstrap;
    if (bs && Number.isFinite(bs.replicates)) rows.push(['Εύρη αβεβαιότητας (10–90%)', `${bs.replicates} επαναλήψεις bootstrap`]);
    if ('calibration' in params) rows.push(['Διόρθωση πιθανοτήτων (βαθμονόμηση)', params.calibration ? 'ενεργή' : 'καμία (δεν βελτίωνε τις προβλέψεις)']);
    const tuned = params.tuned;
    if (tuned && typeof tuned === 'object') {
      const when = tuned.generatedAt ? new Date(tuned.generatedAt) : null;
      rows.push([
        'Ρυθμίσεις μοντέλου',
        tuned.source === 'tuned' ? `βελτιστοποιημένες για τη λίγκα${when && !Number.isNaN(when.getTime()) ? ` (${formatStamp(when)})` : ''}` : 'προεπιλογές',
      ]);
    }
    const sp = params.scorerPrior;
    if (sp && Number.isFinite(sp.a) && Number.isFinite(sp.b)) {
      rows.push(['Prior σκόρερ (Gamma)', `a ${num(sp.a, 2)} · b ${num(sp.b, 1)} (${sp.source === 'eb' ? 'εκτιμήθηκε από τη λίγκα' : 'προεπιλογή'})`]);
    }
    return rows;
  }

  /** Technical rows of the Elo-only model of the Champions League. */
  function eloOnlyRows(m, params) {
    const e = params.eloOnly;
    if (!e || typeof e !== 'object') return [];
    const rows = [];
    if (Number.isFinite(e.kappa)) rows.push(['Κλίση Elo (κ)', `${num(e.kappa, 2)}${Number.isFinite(e.kappaSe) ? ` ± ${num(e.kappaSe, 2)}` : ''} · γκολ ανά 800 μονάδες διαφοράς Elo`]);
    if (Number.isFinite(e.eta)) rows.push([m.neutral ? 'Πλεονέκτημα έδρας' : 'Πλεονέκτημα έδρας (μοντέλο Elo)', m.neutral ? '0 (ουδέτερο γήπεδο)' : minus(num(e.eta, 3))]);
    if (Number.isFinite(e.pooledMatches)) rows.push(['Εγχώριοι αγώνες για την κλίση', String(e.pooledMatches)]);
    if (Number.isFinite(e.cupMatches)) rows.push(['Αγώνες Champions League για το επίπεδο γκολ', `${e.cupMatches}${Number.isFinite(e.cupWeight) ? ` (βάρος ${Math.round(e.cupWeight * 100)}%)` : ''}`]);
    return rows;
  }

  function analysisTab({ m, league, now }) {
    const params = league.params || {};
    const teams = league.teams || {};
    const th = teams[m.home];
    const ta = teams[m.away];
    const badges = matchBadges(m, league, now);
    const a = m.analysis;
    const aiModel = typeof a?.model === 'string' && a.model ? ` (${a.model})` : '';
    const source =
      a?.source === 'ai'
        ? `Το κείμενο γράφτηκε από γλωσσικό μοντέλο${aiModel} με βάση τους αριθμούς του μοντέλου και δεν προσθέτει δικούς του αριθμούς.`
        : 'Αυτόματο κείμενο από πρότυπο· οι αριθμοί είναι οι ίδιοι με αυτούς των καρτελών.';
    const age = ageHours(league.updatedAt, now);
    const tech = [];
    tech.push(['Αναμενόμενα γκολ', `${num(m.model.lam, 2)} ${DASH} ${num(m.model.mu, 2)}`]);
    tech.push(['Διόρθωση χαμηλών σκορ (ρ)', minus(num(m.model.rho, 3))]);
    if (th && ta && Number.isFinite(th.elo) && Number.isFinite(ta.elo)) tech.push(['Elo', `${m.homeName} ${Math.round(th.elo)} · ${m.awayName} ${Math.round(ta.elo)}`]);
    if (th && ta && Number.isFinite(th.nEff) && Number.isFinite(ta.nEff)) tech.push(['Αγώνες δεδομένων (ισοδύναμοι)', `${Math.round(th.nEff)} / ${Math.round(ta.nEff)}`]);
    if (Number.isFinite(params.trainMatches)) tech.push(['Αγώνες εκπαίδευσης', String(params.trainMatches)]);
    if (Number.isFinite(params.eta)) tech.push(['Πλεονέκτημα έδρας', minus(num(params.eta, 3))]);
    tech.push(...eloOnlyRows(m, params));
    tech.push(...phase2Rows(params));
    const hs = params.halfShare;
    if (hs && Number.isFinite(hs.s)) tech.push(['Μερίδιο γκολ στο α\' ημίχρονο', `${Math.round(hs.s * 100)}% (${hs.n} αγώνες)`]);
    if (league.updatedAt) {
      const d = new Date(league.updatedAt);
      tech.push(['Ενημέρωση δεδομένων', `${Number.isNaN(d.getTime()) ? '–' : formatStamp(d)} (${agoText(age)})`]);
    }
    return [
      block('Σύντομη ανάλυση', h('p', { class: 'analysis' }, a?.text || 'Δεν υπάρχει διαθέσιμη ανάλυση.'), note(source)),
      badges.length
        ? block('Τι σημαίνουν τα σήματα', h('ul', { class: 'help' }, badges.map((b) => h('li', null, h('b', null, b.text), ` — ${b.help}`))))
        : null,
      block(
        'Τεχνικά στοιχεία',
        h('dl', { class: 'tech' }, tech.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        note(
          m.scorers?.absences
            ? 'Στατιστικές εκτιμήσεις, όχι εγγύηση. Το μοντέλο δεν γνωρίζει συνθέσεις, καιρό ή κίνητρο· οι απουσίες των σκόρερ λαμβάνονται υπόψη μόνο όταν τις δίνει το API-Football.'
            : 'Στατιστικές εκτιμήσεις, όχι εγγύηση. Το μοντέλο δεν γνωρίζει συνθέσεις, τραυματισμούς, καιρό ή κίνητρο.',
        ),
        m.flags?.eloOnly && league.notes?.eloOnly ? note(league.notes.eloOnly) : null,
      ),
    ];
  }

  const TAB_BUILDERS = { result: resultTab, goals: goalsTab, corners: cornersTab, cards: cardsTab, scorers: scorersTab, analysis: analysisTab };

  /** Nodes of one tab (optional blocks that do not apply are dropped). */
  function tabContent(tabId, entry, ctx) {
    const build = TAB_BUILDERS[tabId] || resultTab;
    return build({ m: entry.m, league: entry.league, now: ctx.now }).flat().filter(Boolean);
  }

  // ----------------------------------------------------------- card pieces --
  function quick(label, p, range) {
    const rt = rangeText(range);
    return h('span', { class: 'q' }, h('small', null, label), h('b', null, fmtPct(p)), rt ? h('small', { class: 'rng' }, rt) : null);
  }

  /** Content of the always-visible card header button. */
  function headContent(entry, { showLeague, now }) {
    const { m, league } = entry;
    const x = m.goals.oneX2;
    const [ph, pd, pa] = pctSet([x.home, x.draw, x.away]);
    const o25 = m.goals.totals.find((t) => t.line === 2.5);
    const badges = matchBadges(m, league, now);
    const cell = (sym, shown, cls, range) =>
      h('span', { class: `c ${cls}` }, h('small', null, sym), h('b', null, shown), rangeText(range) ? h('small', { class: 'rng' }, rangeText(range)) : null);
    return [
      h(
        'span',
        { class: 'meta' },
        h('b', { class: 'time' }, formatTime(new Date(m.kickoff))),
        showLeague ? h('span', { class: 'lg' }, league.league.name) : null,
        stageLabel(m.stage) ? h('span', { class: 'md' }, stageLabel(m.stage)) : null,
        m.matchday && (!m.stage || m.stage === 'LEAGUE_STAGE' || m.stage === 'GROUP_STAGE') ? h('span', { class: 'md' }, `Αγ. ${m.matchday}`) : null,
        m.neutral ? h('span', { class: 'md' }, 'ουδέτερο γήπεδο') : null,
      ),
      h('span', { class: 'teams' }, h('span', { class: 't' }, m.homeName), h('span', { class: 'vs' }, DASH), h('span', { class: 't' }, m.awayName)),
      badges.length ? h('span', { class: 'badges' }, badges.map((b) => h('span', { class: `pill ${b.tone}`, title: b.help }, b.text))) : null,
      h(
        'span',
        { class: 'x12', role: 'img', 'aria-label': `Πιθανότητες: νίκη ${m.homeName} ${ph}, ισοπαλία ${pd}, νίκη ${m.awayName} ${pa}` },
        cell('1', ph, 'home', rangeOf(m, 'oneX2.home')),
        cell('Χ', pd, 'draw', rangeOf(m, 'oneX2.draw')),
        cell('2', pa, 'away', rangeOf(m, 'oneX2.away')),
      ),
      h(
        'span',
        { class: 'stack', 'aria-hidden': 'true' },
        h('i', { class: 'home', width: `${(clamp01(x.home) * 100).toFixed(1)}%` }),
        h('i', { class: 'draw', width: `${(clamp01(x.draw) * 100).toFixed(1)}%` }),
        h('i', { class: 'away', width: `${(clamp01(x.away) * 100).toFixed(1)}%` }),
      ),
      h(
        'span',
        { class: 'quick' },
        o25 ? quick('Over 2,5', o25.over, rangeOf(m, 'over25')) : null,
        quick('GG', m.goals.btts.yes, rangeOf(m, 'btts')),
        h('span', { class: 'q' }, h('small', { title: 'Αναμενόμενα γκολ του μοντέλου' }, 'xG'), h('b', null, `${num(m.model.lam, 2)} ${DASH} ${num(m.model.mu, 2)}`)),
      ),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'),
    ];
  }

  /** Tab bar + the panel of the selected tab. */
  function panelContent(entry, tabId, ctx) {
    const id = safeId(entry.key);
    return h(
      'div',
      { class: 'panel-in' },
      h(
        'div',
        { class: 'tabs', role: 'tablist', 'aria-label': 'Αγορές' },
        TABS.map(([tid, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: 'tab',
              role: 'tab',
              id: `tab-${id}-${tid}`,
              'data-tab': tid,
              'aria-selected': tid === tabId ? 'true' : 'false',
              'aria-controls': `tp-${id}`,
              tabindex: tid === tabId ? '0' : '-1',
            },
            label,
          ),
        ),
      ),
      h('div', { class: 'tp', role: 'tabpanel', id: `tp-${id}`, 'aria-labelledby': `tab-${id}-${tabId}`, tabindex: '0' }, tabContent(tabId, entry, ctx)),
    );
  }

  return { headContent, panelContent, tabContent };
}
