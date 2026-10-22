// DOM builders for the reliability report (view "Αξιοπιστία", data: report.json).
// Only createElement / textContent are used, like the rest of the page: league names and
// messages come from a data file and must never be interpreted as HTML. Every number is
// read defensively, because the file may come from an older or newer version of the job.

import { num } from './format.js';
import {
  ageHours, agoText, calibrationReasonText, fmtDec, fmtPct1, fmtPoints, fmtSkill, formatStamp, halfLifeDays, skillTone,
} from './util.js';

const DASH = '–';
const STALE_REPORT_DAYS = 10; // the job runs weekly

/** Reliability diagrams: key in report.leagues[x].calibration -> label. */
export const CAL_MARKETS = [
  ['home', 'Νίκη γηπεδούχου (1)'],
  ['draw', 'Ισοπαλία (Χ)'],
  ['away', 'Νίκη φιλοξενούμενου (2)'],
  ['ou25', 'Over 2,5 γκολ'],
  ['btts', 'GG (σκοράρουν και οι δύο)'],
];

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const get = (obj, ...path) => path.reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const pc0 = (x) => (finite(x) ? `${Math.round(x * 100)}%` : DASH);

/** "+0,042 ± 0,007"; no sign when the difference rounds to zero. */
function gainText(gain, se) {
  if (!finite(gain)) return DASH;
  const v = Math.abs(gain).toFixed(3).replace('.', ',');
  const sign = Math.abs(gain) < 0.0005 ? '' : gain < 0 ? '−' : '+';
  return `${sign}${v}${finite(se) ? ` ± ${se.toFixed(3).replace('.', ',')}` : ''}`;
}

export function createReliability(h) {
  const block = (title, ...kids) => h('section', { class: 'blk' }, title ? h('h4', null, title) : null, kids);
  const note = (text) => h('p', { class: 'note' }, text);
  const empty = (text) => h('p', { class: 'empty' }, text);

  /** Small table: head = column titles (first one is the row-label column), rows = [{ label, sub, cells, cls }]. */
  function table(caption, head, rows) {
    return h(
      'div',
      { class: 'rel-scroll' },
      h(
        'table',
        { class: 'rel-t' },
        h('caption', { class: 'sr-only' }, caption),
        h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col' }, c)))),
        h(
          'tbody',
          null,
          rows.map((r) =>
            h(
              'tr',
              { class: r.cls || null },
              h('th', { scope: 'row' }, r.label, r.sub ? h('small', null, r.sub) : null),
              r.cells.map((c) => (c && typeof c === 'object' && 'text' in c ? h('td', { class: c.cls || null }, c.text) : h('td', null, c))),
            ),
          ),
        ),
      ),
    );
  }

  const tile = (label, value, cls = '') => h('span', { class: `stat${cls ? ` ${cls}` : ''}` }, h('small', null, label), h('b', null, value));

  // ----------------------------------------------------------- one league --
  const REFS = [
    ['model', 'Μοντέλο', null],
    ['base', 'Βασικές συχνότητες λίγκας', 'ίδια πρόβλεψη για κάθε αγώνα'],
    ['poisson', 'Απλό Poisson', 'χωρίς φθίνουσα βαρύτητα, xG, Elo'],
    ['phase1', 'Προηγούμενη έκδοση', 'μόνο γκολ, χωρίς xG/Elo'],
  ];

  function errorsTable(r) {
    const m = r.metrics || {};
    return table(
      'Σφάλμα πρόβλεψης ανά μέθοδο (μικρότερο = καλύτερο)',
      ['', 'RPS 1Χ2', 'Log\u2011loss 1Χ2', 'Log\u2011loss Over 2,5', 'Log\u2011loss GG'],
      REFS.filter(([k]) => m[k]).map(([k, label, sub]) => ({
        label,
        sub,
        cls: k === 'model' ? 'me' : null,
        cells: [fmtDec(get(m, k, 'x12', 'rps')), fmtDec(get(m, k, 'x12', 'logLoss')), fmtDec(get(m, k, 'ou25', 'logLoss')), fmtDec(get(m, k, 'btts', 'logLoss'))],
      })),
    );
  }

  function skillTable(r, minSkill) {
    const s = r.skill || {};
    const refs = [
      ['vsBase', 'Βασικές συχνότητες'],
      ['vsPoisson', 'Απλό Poisson'],
      ['vsPhase1', 'Προηγούμενη έκδοση'],
    ].filter(([k]) => s[k]);
    return table(
      'Βελτίωση του μοντέλου έναντι κάθε αναφοράς (θετικό = καλύτερο)',
      ['', 'RPS', '1Χ2', 'Over 2,5', 'GG'],
      refs.map(([k, label]) => ({
        label,
        cells: [
          { text: fmtSkill(s[k].rps), cls: k === 'vsBase' ? `sk ${skillTone(s[k].rps, minSkill)}` : 'sk' },
          fmtSkill(s[k].logLoss1x2),
          fmtSkill(s[k].ou25),
          fmtSkill(s[k].btts),
        ],
      })),
    );
  }

  function brierTable(r) {
    const m = r.metrics || {};
    return table(
      'Brier score ανά μέθοδο (μικρότερο = καλύτερο)',
      ['', '1Χ2', 'Over 2,5', 'GG'],
      REFS.filter(([k]) => m[k]).map(([k, label]) => ({
        label,
        cls: k === 'model' ? 'me' : null,
        cells: [fmtDec(get(m, k, 'x12', 'brier')), fmtDec(get(m, k, 'ou25', 'brier')), fmtDec(get(m, k, 'btts', 'brier'))],
      })),
    );
  }

  function seasonTable(r, minSkill) {
    const rows = [];
    for (const [key, label, sub] of [
      ['early', 'Αρχή σεζόν', 'πρώτες 8 εβδομάδες'],
      ['rest', 'Υπόλοιπη σεζόν', null],
    ]) {
      const p = get(r, 'season', key);
      if (!p) {
        rows.push({ label, sub, cells: [DASH, DASH, DASH, DASH] });
        continue;
      }
      rows.push({
        label,
        sub,
        cells: [String(p.n ?? DASH), fmtDec(get(p, 'x12', 'rps')), fmtDec(get(p, 'base', 'x12', 'rps')), { text: fmtSkill(get(p, 'skill', 'rps')), cls: `sk ${skillTone(get(p, 'skill', 'rps'), minSkill)}` }],
      });
    }
    return table('Αρχή της σεζόν και υπόλοιπη σεζόν', ['', 'Αγώνες', 'RPS μοντέλου', 'RPS συχνοτήτων', 'Βελτίωση'], rows);
  }

  function calibrationBlock(r) {
    const cal = r.calibration || {};
    const items = CAL_MARKETS.filter(([k]) => cal[k] && Array.isArray(cal[k].bins)).map(([k, label]) => {
      const c = cal[k];
      const total = c.bins.reduce((s, b) => s + (finite(b.n) ? b.n : 0), 0);
      return h(
        'details',
        { class: 'rel-sub' },
        h('summary', null, h('span', null, label), h('small', null, `κλίση ${fmtDec(c.slope, 2)} · ${total} προβλέψεις`)),
        table(
          `Βαθμονόμηση: ${label}`,
          ['Διάστημα', 'Μέση πρόβλεψη', 'Πραγματικό', 'Αγώνες'],
          c.bins.map((b) => ({
            label: `${pc0(b.lo)}–${pc0(b.hi)}`,
            cls: finite(b.n) && b.n < 20 ? 'few' : null,
            cells: [pc0(b.p), pc0(b.f), String(b.n ?? DASH)],
          })),
        ),
        note('Διάστημα = ομάδα προβλέψεων με παρόμοια πιθανότητα. Μέση πρόβλεψη = η μέση πιθανότητα που έδωσε το μοντέλο εκεί. Πραγματικό = πόσες φορές έγινε τελικά. Οι γραμμές με λίγους αγώνες (γκρι) δεν είναι αξιόπιστες.'),
      );
    });
    if (items.length === 0) return null;
    return block(
      'Βαθμονόμηση (όταν λέει 30%, γίνεται το 30%;)',
      note('Κλίση 1,00 = τέλεια. Κάτω από 1: οι πιθανότητες είναι υπερβολικά ακραίες. Πάνω από 1: υπερβολικά συντηρητικές. Μικρές αποκλίσεις είναι φυσιολογικές.'),
      items,
    );
  }

  function countsBlock(r) {
    const c = r.counts || {};
    const rows = [];
    for (const [key, label] of [
      ['corners', 'Κόρνερ'],
      ['yellows', 'Κίτρινες κάρτες'],
    ]) {
      const x = c[key];
      if (!x) {
        rows.push({ label, cells: [DASH, DASH, DASH, DASH] });
        continue;
      }
      rows.push({
        label,
        cells: [String(x.n ?? DASH), fmtDec(x.negbin, 3), fmtDec(x.poisson, 3), gainText(x.gain, x.gainSe)],
      });
    }
    if (rows.every((x) => x.cells[0] === DASH)) return null;
    return block(
      'Κόρνερ και κίτρινες κάρτες',
      table('Μοντέλο μετρήσεων έναντι απλού Poisson (log-score ανά αγώνα, μεγαλύτερο = καλύτερο)', ['', 'Αγώνες', 'Μοντέλο', 'Poisson', 'Διαφορά'], rows),
      note('Log-score ανά αγώνα (μεγαλύτερο = καλύτερο). Θετική διαφορά σημαίνει ότι το μοντέλο μετρήσεων (αρνητική διωνυμική όπου χρειάζεται) είναι καλύτερο από απλό Poisson· κοντά στο μηδέν σημαίνει ότι το απλό Poisson αρκεί και χρησιμοποιείται αυτό.'),
    );
  }

  /** Half-time markets (Phase 3). Absent in reports of older versions or when too few matches have a half-time score. */
  function htftBlock(r) {
    const x = r.htft;
    if (!x || typeof x !== 'object' || !x.model || !x.base) return null;
    const sk = x.skill || {};
    const row = (label, sub, path, skillKey, dec = 3) => {
      const model = get(x, 'model', ...path);
      const base = get(x, 'base', ...path);
      return {
        label,
        sub,
        cells: [fmtDec(model, dec), fmtDec(base, dec), { text: fmtSkill(sk[skillKey]), cls: 'sk' }],
      };
    };
    const rows = [
      row('Αποτέλεσμα ημιχρόνου', 'RPS', ['ht', 'rps'], 'htRps'),
      row('Αποτέλεσμα ημιχρόνου', 'log-loss', ['ht', 'logLoss'], 'htLogLoss'),
      row('Ημίχρονο/Τελικός (9 συνδυασμοί)', 'log-loss', ['htft', 'logLoss'], 'htft'),
      row('Over 0,5 γκολ στο 1ο ημίχρονο', 'log-loss', ['over05', 'logLoss'], 'over05'),
      row('Over 1,5 γκολ στο 1ο ημίχρονο', 'log-loss', ['over15', 'logLoss'], 'over15'),
    ].filter((rw) => rw.cells[0] !== DASH);
    if (rows.length === 0) return null;
    return block(
      'Ημίχρονο και ημίχρονο/τελικός',
      table(`Αγορές ημιχρόνου, ${x.n ?? DASH} αγώνες με σκορ ημιχρόνου (μικρότερο σφάλμα = καλύτερο)`, ['', 'Μοντέλο', 'Συχνότητες', 'Βελτίωση'], rows),
      note('Οι αγορές του ημιχρόνου προκύπτουν από το τελικό σκορ με ένα σταθερό ποσοστό γκολ στο 1ο ημίχρονο για τη λίγκα· δεν μοντελοποιούν ξεχωριστά τα δύο ημίχρονα. Γι’ αυτό οι ανατροπές (π.χ. 1/2) τείνουν να υποεκτιμώνται. Θετική βελτίωση = καλύτερο από τις βασικές συχνότητες της λίγκας.'),
    );
  }

  function paramsBlock(r) {
    const p = r.params || {};
    const t = r.tuning || {};
    const rows = [];
    rows.push(['Επιλογή παραμέτρων', t.source === 'tuned' ? 'βελτιστοποιημένες για τη λίγκα' : 'προεπιλογές (δεν βρέθηκε σαφώς καλύτερη ρύθμιση)']);
    if (finite(p.xi)) {
      const half = halfLifeDays(p.xi);
      rows.push(['Φθίνουσα βαρύτητα παλαιότητας (ξ)', `${num(p.xi, 4)}${half ? ` (ημιζωή περίπου ${half} ημέρες)` : ''}`]);
    }
    if (finite(p.sigma)) rows.push(['Ομαλοποίηση ομάδων (σ)', num(p.sigma, 2)]);
    if (finite(p.om)) rows.push(['Βάρος πραγματικών γκολ (ω)', p.om >= 1 ? '100% (χωρίς xG-proxy)' : `${Math.round(p.om * 100)}% γκολ + ${Math.round((1 - p.om) * 100)}% xG-proxy από τα σουτ`]);
    if (typeof p.elo === 'boolean') {
      const e = r.elo || {};
      const extra = finite(e.coverage) ? ` · κάλυψη ονομάτων ${Math.round(e.coverage * 100)}%` : '';
      rows.push(['Elo ως αρχική εκτίμηση (prior)', p.elo ? `ναι${extra}` : t.eloEvaluated === false ? 'ναι (δεν αξιολογήθηκε: λείπουν δεδομένα Elo)' : 'όχι']);
    }
    if (finite(get(t, 'objective', 'default')) && finite(get(t, 'objective', 'tuned'))) {
      rows.push(['Στόχος βελτιστοποίησης (άθροισμα log-loss)', `προεπιλογή ${fmtDec(t.objective.default, 4)} → επιλεγμένες ${fmtDec(t.objective.tuned, 4)}${finite(t.gainSe) ? ` (διαφορά ${fmtDec(t.gain, 4)} ± ${fmtDec(t.gainSe, 4)})` : ''}`]);
    }
    if (finite(t.backtests)) rows.push(['Δοκιμές ρυθμίσεων', String(t.backtests)]);
    const w = get(r, 'ranges', 'meanWidth');
    if (w && finite(w.home)) rows.push(['Μέσο εύρος 10–90% (νίκη γηπεδούχου · Over 2,5 · GG)', `${fmtPoints(w.home)} · ${fmtPoints(w.over25)} · ${fmtPoints(w.btts)}`]);
    return block('Ρυθμίσεις και αβεβαιότητα', h('dl', { class: 'tech' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  function leagueCard(code, r, { minSkill }) {
    const name = typeof r?.name === 'string' && r.name ? r.name : code;
    if (!r || !r.metrics) {
      return h(
        'div',
        { class: 'card rel-league rel-error' },
        h('div', { class: 'rl-head' }, h('span', { class: 'rl-name' }, name), h('span', { class: 'pill bad' }, 'χωρίς αποτέλεσμα')),
        h('p', { class: 'note' }, `Δεν υπάρχει αξιολόγηση: ${r?.error || r?.skipped || 'άγνωστος λόγος'}.`),
      );
    }
    const skill = get(r, 'skill', 'vsBase', 'rps');
    const flagged = (r.flags || []).some((f) => f?.code === 'skill-below-8pct');
    const tone = r.stale ? 'neutral' : skillTone(skill, minSkill);
    const pills = [];
    if (r.stale) pills.push(h('span', { class: 'pill warn', title: r.staleReason || '' }, 'παλιά αποτελέσματα'));
    if (flagged && !r.stale) pills.push(h('span', { class: 'pill bad' }, 'κάτω από το όριο'));
    return h(
      'details',
      { class: `card rel-league${flagged ? ' flagged' : ''}`, 'data-code': code },
      h(
        'summary',
        null,
        h('span', { class: 'rl-name' }, name, h('small', null, `${r.matches ?? DASH} αγώνες`), pills.length ? h('span', { class: 'badges' }, pills) : null),
        h('span', { class: `rl-skill ${tone}`, title: 'Βελτίωση του RPS έναντι των βασικών συχνοτήτων της λίγκας' }, fmtSkill(skill)),
      ),
      h(
        'div',
        { class: 'rl-body' },
        r.stale ? h('p', { class: 'banner warn' }, `Αυτά είναι τα αποτελέσματα προηγούμενης εβδομάδας: ${r.staleReason || 'ο φετινός έλεγχος απέτυχε'}.`) : null,
        (r.flags || []).filter((f) => f?.message).map((f) => h('p', { class: `banner ${f.code === 'skill-below-8pct' ? 'bad' : 'warn'}` }, f.message)),
        block('Σφάλμα πρόβλεψης (μικρότερο = καλύτερο)', errorsTable(r)),
        block('Βελτίωση του μοντέλου έναντι…', skillTable(r, minSkill), note('Θετικό = το μοντέλο είναι καλύτερο από την αναφορά. Ο στόχος είναι να ξεπερνά τις βασικές συχνότητες κατά τουλάχιστον 8% στο RPS.')),
        h('details', { class: 'rel-sub' }, h('summary', null, h('span', null, 'Brier score')), brierTable(r)),
        block('Αρχή σεζόν και υπόλοιπη σεζόν', seasonTable(r, minSkill), note('Στην αρχή της σεζόν υπάρχει λιγότερη πληροφορία για τις ομάδες, οπότε οι προβλέψεις είναι λιγότερο ακριβείς.')),
        calibrationBlock(r),
        countsBlock(r),
        htftBlock(r),
        paramsBlock(r),
      ),
    );
  }

  // ------------------------------------- Elo-only model of the Champions League --
  // The cup cannot be checked on its own matches, so the weekly job tests the same formula on domestic matches
  // (report.eloOnly, absent in reports of older versions of the job).
  const EO_REFS = [
    ['model', 'Μοντέλο μόνο-Elo', 'όπως στο Champions League'],
    ['leagueModel', 'Πλήρες μοντέλο λίγκας', 'για σύγκριση: ξέρει το ιστορικό κάθε ομάδας'],
    ['base', 'Βασικές συχνότητες', 'όλες οι λίγκες μαζί, ίδια πρόβλεψη για κάθε αγώνα'],
  ];

  function eloOnlyCard(e) {
    if (!e || typeof e !== 'object' || !e.metrics || !e.metrics.model || !e.metrics.base) return null;
    const sets = { model: e.metrics.model, leagueModel: get(e, 'leagueModel', 'metrics'), base: e.metrics.base };
    const sk = get(e, 'skill', 'vsBase', 'rps');
    const flags = (Array.isArray(e.flags) ? e.flags : []).filter((f) => f && typeof f.message === 'string');
    const tone = e.stale ? 'neutral' : finite(sk) && sk < 0 ? 'bad' : 'neutral';
    const pills = [];
    if (e.stale) pills.push(h('span', { class: 'pill warn', title: e.staleReason || '' }, 'παλιά αποτελέσματα'));
    if (flags.length > 0 && !e.stale) pills.push(h('span', { class: 'pill bad' }, 'κάτω από τις συχνότητες'));

    const errors = table(
      'Σφάλμα πρόβλεψης ανά μέθοδο σε εγχώριους αγώνες (μικρότερο = καλύτερο)',
      ['', 'RPS 1Χ2', 'Log‑loss 1Χ2', 'Log‑loss Over 2,5', 'Log‑loss GG'],
      EO_REFS.filter(([k]) => sets[k]).map(([k, label, sub]) => ({
        label,
        sub,
        cls: k === 'model' ? 'me' : null,
        cells: [fmtDec(get(sets, k, 'x12', 'rps')), fmtDec(get(sets, k, 'x12', 'logLoss')), fmtDec(get(sets, k, 'ou25', 'logLoss')), fmtDec(get(sets, k, 'btts', 'logLoss'))],
      })),
    );

    const gap = e.bigGap && typeof e.bigGap === 'object' ? e.bigGap : null;
    const skillRows = [
      ['Βασικές συχνότητες', null, get(e, 'skill', 'vsBase'), true],
      ['Πλήρες μοντέλο λίγκας', 'αναμένεται αρνητικό: δεν ξέρει το ιστορικό των ομάδων', get(e, 'skill', 'vsLeagueModel'), false],
      gap && finite(gap.threshold) ? [`Βασικές συχνότητες, μόνο μεγάλες διαφορές Elo (≥ ${Math.round(gap.threshold)} βαθμοί)`, `${gap.n ?? DASH} αγώνες${finite(gap.share) ? ` · ${pc0(gap.share)} του δείγματος` : ''}`, get(gap, 'skill', 'vsBase'), false] : null,
    ]
      .filter((r) => r && r[2])
      .map(([label, sub, s, main]) => ({
        label,
        sub,
        cells: [{ text: fmtSkill(s.rps), cls: main ? `sk ${finite(s.rps) && s.rps < 0 ? 'bad' : 'neutral'}` : 'sk' }, fmtSkill(s.logLoss1x2), fmtSkill(s.ou25), fmtSkill(s.btts)],
      }));

    const fit = e.fit && typeof e.fit === 'object' ? e.fit : {};
    const range = (s, d) => (s && finite(s.mean) ? `${num(s.mean, d)}${finite(s.min) && finite(s.max) ? ` (από ${num(s.min, d)} έως ${num(s.max, d)})` : ''}` : null);
    const tech = [];
    const codes = Array.isArray(e.leagues) ? e.leagues.filter((c) => typeof c === 'string') : [];
    if (codes.length > 0) tech.push(['Λίγκες στο δείγμα', codes.join(', ')]);
    if (finite(e.n)) tech.push(['Αγώνες που βαθμολογήθηκαν', `${e.n}${finite(e.scored) && e.scored !== e.n ? ` (από ${e.scored}· τους υπόλοιπους δεν τους είχε βαθμολογήσει το πλήρες μοντέλο)` : ''}`]);
    if (finite(e.origins)) tech.push(['Εβδομαδιαίες αφετηρίες', `${e.origins}${finite(e.skippedOrigins) && e.skippedOrigins > 0 ? ` (${e.skippedOrigins} παραλείφθηκαν: ελάχιστα δεδομένα στην αρχή)` : ''}`]);
    if (range(fit.kappa, 2)) tech.push(['Κλίση Elo (κ): πόσο μετράει η διαφορά βαθμολογίας', range(fit.kappa, 2)]);
    if (range(fit.eta, 2)) tech.push(['Πλεονέκτημα έδρας (η)', range(fit.eta, 2)]);
    if (e.source === 'own') tech.push(['Βαθμολογίες Elo', 'δικός μας υπολογισμός από αποτελέσματα']);
    const alt = e.alt && typeof e.alt === 'object' ? e.alt : null;
    if (alt && alt.status === 'ok' && finite(alt.rps) && finite(alt.ownRps)) {
      const verdict = alt.better === 'clubelo' ? 'το ClubElo βγήκε καλύτερο' : alt.better === 'own' ? 'το δικό μας Elo βγήκε καλύτερο' : 'ισοδύναμα';
      tech.push(['Σύγκριση με το ClubElo (RPS)', `δικό μας ${fmtDec(alt.ownRps)} · ClubElo ${fmtDec(alt.rps)} → ${verdict}`]);
    } else if (alt && alt.status === 'unavailable') {
      tech.push(['Σύγκριση με το ClubElo', 'το ClubElo δεν απαντά αυτή την εβδομάδα']);
    }
    if (finite(e.unrated) && e.unrated > 0) tech.push(['Αγώνες χωρίς βαθμολογία Elo και για τις δύο ομάδες', String(e.unrated)]);

    return h(
      'details',
      { class: `card rel-league rel-cl${tone === 'bad' && !e.stale ? ' flagged' : ''}`, 'data-code': 'CL' },
      h(
        'summary',
        null,
        h('span', { class: 'rl-name' }, 'Champions League (μόνο Elo)', h('small', null, `δοκιμή σε εγχώριους αγώνες · ${e.n ?? DASH} αγώνες`), pills.length ? h('span', { class: 'badges' }, pills) : null),
        h('span', { class: `rl-skill ${tone}`, title: 'Βελτίωση του RPS έναντι των βασικών συχνοτήτων (όλες οι λίγκες μαζί)' }, fmtSkill(sk)),
      ),
      h(
        'div',
        { class: 'rl-body' },
        e.stale ? h('p', { class: 'banner warn' }, `Αυτά είναι τα αποτελέσματα προηγούμενης εβδομάδας: ${e.staleReason || 'ο φετινός έλεγχος απέτυχε'}.`) : null,
        flags.map((f) => h('p', { class: 'banner warn' }, f.message)),
        note('Οι πιθανότητες του Champions League και του Europa League προκύπτουν μόνο από τη βαθμολογία Elo των δύο ομάδων. Επειδή η διοργάνωση δεν έχει αρκετούς δικούς της αγώνες για έλεγχο, ο ίδιος τύπος δοκιμάζεται εδώ σε αγώνες των εγχώριων λιγκών, με τον ίδιο τρόπο όπως παραπάνω: κάθε εβδομάδα προβλέπει τους αγώνες των επόμενων 7 ημερών έχοντας δει μόνο όσους προηγήθηκαν.'),
        block('Σφάλμα πρόβλεψης (μικρότερο = καλύτερο)', errors),
        skillRows.length > 0
          ? block(
              'Βελτίωση του μοντέλου μόνο-Elo έναντι…',
              table('Βελτίωση του μοντέλου μόνο-Elo έναντι κάθε αναφοράς (θετικό = καλύτερο)', ['', 'RPS', '1Χ2', 'Over 2,5', 'GG'], skillRows),
              note('Θετικό = το μόνο-Elo είναι καλύτερο από την αναφορά. Σε σύγκριση με το πλήρες μοντέλο της λίγκας είναι φυσιολογικό να βγαίνει χειρότερο· η διαφορά δείχνει πόσο λιγότερη βεβαιότητα έχουν οι πιθανότητες του Champions League.'),
            )
          : null,
        tech.length > 0 ? block('Ρυθμίσεις και δείγμα', h('dl', { class: 'tech' }, tech.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))) : null,
        note('Δεν ελέγχονται εδώ: το επίπεδο γκολ του ίδιου του Champions League (προσαρμόζεται στα αποτελέσματα της διοργάνωσης), ο τελικός σε ουδέτερο γήπεδο και οι διαφορές βαθμολογίας ανάμεσα σε ομάδες διαφορετικών χωρών. Ο έλεγχος χρησιμοποιεί τη βαθμολογία Elo της αρχής του μήνα, που μπορεί να είναι έως ένα μήνα παλιότερη από όση χρησιμοποιεί η καθημερινή πρόβλεψη.'),
      ),
    );
  }

  // ---------------------------------------------------------------- report --
  const REASONS = {
    x12: 'Αποτέλεσμα 1Χ2',
    ou25: 'Over/Under 2,5',
    btts: 'GG',
  };

  function calibrationLayer(report) {
    const layer = report.calibrationLayer;
    const markets = layer && typeof layer.markets === 'object' && layer.markets ? Object.entries(layer.markets) : [];
    if (markets.length === 0) return null;
    return block(
      'Προαιρετική διόρθωση πιθανοτήτων',
      table(
        'Αν η διόρθωση πιθανοτήτων εφαρμόζεται ανά αγορά',
        ['Αγορά', 'Κατάσταση', 'Κέρδος ± σφάλμα'],
        markets.map(([k, v]) => ({
          label: REASONS[k] || k,
          sub: !v?.adopt ? calibrationReasonText(v?.reason) : null,
          cells: [v?.adopt ? 'εφαρμόζεται' : 'δεν εφαρμόζεται', `${fmtDec(v?.gain, 4)} ± ${fmtDec(v?.se, 4)}`],
        })),
      ),
      note('Μια τελική διόρθωση των πιθανοτήτων χρησιμοποιείται μόνο αν βελτιώνει καθαρά τις προβλέψεις σε αγώνες που δεν είχε δει κατά την προσαρμογή (έλεγχος εκτός δείγματος). Αλλιώς οι πιθανότητες μένουν όπως τις υπολογίζει το μοντέλο.'),
    );
  }

  function explainer() {
    const item = (term, text) => h('li', null, h('b', null, term), ` — ${text}`);
    return h(
      'details',
      { class: 'rel-sub rel-how' },
      h('summary', null, h('span', null, 'Πώς διαβάζω τους αριθμούς')),
      h(
        'ul',
        { class: 'help' },
        item('RPS', 'μέτρο σφάλματος για το αποτέλεσμα 1Χ2 (η ισοπαλία είναι ενδιάμεση ανάμεσα σε νίκη και ήττα). Μικρότερο = καλύτερο.'),
        item('Log-loss', 'μεγάλη «ποινή» όταν δίνεις χαμηλή πιθανότητα σε κάτι που τελικά συνέβη. Μικρότερο = καλύτερο.'),
        item('Brier', 'μέσο τετραγωνικό σφάλμα των πιθανοτήτων. Μικρότερο = καλύτερο.'),
        item('Βασικές συχνότητες', 'μια πρόβλεψη που δίνει σε κάθε αγώνα τα μέσα ποσοστά της λίγκας (π.χ. 45% νίκη γηπεδούχου) χωρίς να ξέρει τις ομάδες. Αν το μοντέλο δεν τις ξεπερνά καθαρά, δεν προσφέρει τίποτα.'),
        item('Απλό Poisson', 'ο ίδιος τύπος μοντέλου χωρίς φθίνουσα βαρύτητα παλαιότητας, xG, Elo και διόρθωση χαμηλών σκορ.'),
        item('Εύρος 10–90%', 'το μοντέλο υπολογίζεται 100 φορές με ελαφρώς διαφορετικά βάρη αγώνων (bootstrap). Το εύρος δείχνει πόσο κινείται η πιθανότητα· δεν είναι εγγύηση.'),
      ),
    );
  }

  /** The whole view as an array of nodes. */
  function reportContent(report, { now }) {
    const minSkill = finite(get(report, 'criteria', 'minSkill')) ? report.criteria.minSkill : 0.08;
    const leagues = Object.entries(report.leagues && typeof report.leagues === 'object' ? report.leagues : {});
    const age = ageHours(report.generatedAt, now);
    const generated = new Date(report.generatedAt);
    const pooled = report.pooled;
    const flaggedNames = leagues.filter(([, r]) => r && !r.stale && (r.flags || []).some((f) => f?.code === 'skill-below-8pct')).map(([c, r]) => r.name || c);

    const out = [];
    out.push(h('h2', { class: 'rel-h' }, 'Πόσο αξιόπιστες είναι οι πιθανότητες;'));
    out.push(
      h(
        'p',
        { class: 'rel-lead' },
        'Κάθε Δευτέρα το μοντέλο δοκιμάζεται σε αγώνες που έχουν ήδη παιχτεί: για κάθε εβδομάδα των δύο τελευταίων ολοκληρωμένων σεζόν προβλέπει τους αγώνες των επόμενων 7 ημερών με όσα ήταν γνωστά πριν από αυτούς, και συγκρίνουμε με το τι έγινε πραγματικά.',
      ),
    );
    if (age !== null && age > STALE_REPORT_DAYS * 24) {
      out.push(h('p', { class: 'banner warn', role: 'status' }, `Ο εβδομαδιαίος έλεγχος δεν έχει ανανεωθεί ${agoText(age).replace('πριν από', 'εδώ και')}. Δες στο GitHub (Actions) αν το workflow «Εβδομαδιαίος έλεγχος αξιοπιστίας» τρέχει.`));
    }
    if (flaggedNames.length > 0 || (pooled?.flags || []).length > 0) {
      out.push(
        h(
          'p',
          { class: 'banner bad', role: 'status' },
          `Προσοχή: ${flaggedNames.length ? `${flaggedNames.join(', ')} ${flaggedNames.length === 1 ? 'ξεπερνά' : 'ξεπερνούν'} τις βασικές συχνότητες λιγότερο από ${Math.round(minSkill * 100)}% στο RPS` : 'το μοντέλο ξεπερνά συνολικά τις βασικές συχνότητες λιγότερο από το όριο'}. Αυτό θεωρείται πιθανό σφάλμα και πρέπει να ελεγχθεί· οι πιθανότητες εκείνης της λίγκας να διαβάζονται με επιφύλαξη.`,
        ),
      );
    }

    if (pooled && finite(get(pooled, 'skill', 'vsBase', 'rps'))) {
      const sk = pooled.skill.vsBase.rps;
      out.push(
        h(
          'p',
          { class: 'stats' },
          tile('Αγώνες ελέγχου', String(pooled.matches ?? DASH)),
          tile('Βελτίωση έναντι συχνοτήτων (RPS)', fmtSkill(sk), `sk ${skillTone(sk, minSkill)}`),
          tile('Ελάχιστο όριο', `≥ ${Math.round(minSkill * 100)}%`),
          tile('Τελευταίος έλεγχος', Number.isNaN(generated.getTime()) ? DASH : formatStamp(generated)),
        ),
      );
    }
    out.push(explainer());

    if (leagues.length === 0) out.push(empty('Η αναφορά δεν περιέχει πρωταθλήματα.'));
    const cup = eloOnlyCard(report.eloOnly);
    out.push(h('div', { class: 'rel-list' }, leagues.map(([code, r]) => leagueCard(code, r, { minSkill })), cup));
    if (!cup) {
      out.push(note('Το Champions League δεν ελέγχεται εδώ: οι πιθανότητές του προκύπτουν μόνο από τη βαθμολογία Elo των ομάδων (χωρίς πλήρες μοντέλο επιθέσεων/άμυνας), γι’ αυτό φέρουν την ένδειξη «χαμηλότερη βεβαιότητα».'));
    }
    out.push(calibrationLayer(report));

    const win = report.window || {};
    const seasons = Array.isArray(win.seasons) ? win.seasons.filter((s) => typeof s === 'string').join(', ') : '';
    const details = [
      seasons ? `σεζόν ελέγχου ${seasons}` : null,
      finite(win.stepDays) ? `βήμα ${win.stepDays} ημέρες` : null,
      finite(win.horizonDays) ? `πρόβλεψη ${win.horizonDays} ημερών ανά βήμα` : null,
      finite(win.bootstrapK) ? `bootstrap ${win.bootstrapK} επαναλήψεων` : null,
      finite(get(report, 'elo', 'have')) ? `Elo: ${report.elo.have}/${report.elo.wanted} στιγμιότυπα` : null,
    ].filter(Boolean);
    if (details.length) out.push(note(`Λεπτομέρειες ελέγχου: ${details.join(' · ')}.`));

    const warnings = Array.isArray(report.warnings) ? report.warnings.filter((w) => w && w.message) : [];
    if (warnings.length > 0) {
      out.push(
        h(
          'details',
          { class: 'rel-sub' },
          h('summary', null, h('span', null, `Ειδοποιήσεις ελέγχου (${warnings.length})`)),
          h('ul', { class: 'help' }, warnings.map((w) => h('li', null, w.message))),
        ),
      );
    }
    out.push(note('Οι έλεγχοι αφορούν παρελθοντικούς αγώνες· δεν εγγυώνται τα μελλοντικά αποτελέσματα.'));
    return out.filter(Boolean);
  }

  return { reportContent };
}
