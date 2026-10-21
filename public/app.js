// Football Probabilities: the browser app (vanilla JS, no dependencies, no inline scripts).
//
// Flow: read config.js -> fetch index.json from the "data" branch -> league chips ->
// fetch the league files lazily -> upcoming matches grouped by day (Athens time) ->
// tap a card to open the six tabs. A second view ("Αξιοπιστία", #reliability) shows the weekly
// back-test report (report.json, see reliability.js). All text that comes from the data is
// inserted with textContent only (see views.js).

import {
  STALE_AFTER_HOURS, agoText, ageHours, athensDay, collectEntries, dataBase, dayHeading, formatStamp, groupByDay, parseHash, parseView, safeFile, staleInfo,
} from './util.js';
import { TABS, createViews, makeH, safeId } from './views.js';
import { createReliability } from './reliability.js';

const STORE_LEAGUE = 'fp-league';
const STORE_THEME = 'fp-theme';
const FETCH_TIMEOUT_MS = 20000;
const RELOAD_AFTER_HIDDEN_MS = 30 * 60 * 1000;

function safeStorage(win) {
  return {
    get(key) {
      try {
        return win.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        win.localStorage.setItem(key, value);
      } catch {
        /* storage blocked (private mode): the page works without it */
      }
    },
  };
}

const fail = (kind, extra = {}) => Object.assign(new Error(kind), { kind }, extra);

export function createApp({
  doc = globalThis.document,
  win = globalThis.window,
  fetchFn = (...args) => globalThis.fetch(...args),
  config = globalThis.window?.FP_CONFIG,
  nowFn = () => new Date(),
  storage = safeStorage(win),
} = {}) {
  const h = makeH(doc);
  const views = createViews(h);
  const reliability = createReliability(h);
  const $ = (id) => doc.getElementById(id);

  const state = {
    base: null,
    index: null,
    leagues: new Map(), // code -> { status: 'loading' | 'ok' | 'error', data, error }
    selected: 'ALL',
    view: 'matches', // 'matches' | 'reliability'
    report: { status: 'idle', data: null, error: null }, // report.json of the weekly back-test
    open: new Set(),
    tabs: new Map(),
    entries: new Map(), // card key -> entry (for lazy panels)
    hiddenAt: null,
    renderQueued: false,
  };

  // ---------------------------------------------------------------- data --
  async function getJson(file) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? win.setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      let res;
      try {
        res = await fetchFn(`${state.base}/${file}`, { cache: 'no-cache', signal: ctl ? ctl.signal : undefined });
      } catch {
        throw fail('network');
      }
      if (!res.ok) throw fail('http', { status: res.status });
      try {
        return await res.json();
      } catch {
        throw fail('format');
      }
    } finally {
      if (timer) win.clearTimeout(timer);
    }
  }

  const leagueMeta = (code) => (state.index.leagues || []).find((l) => l.code === code) || null;
  const selectableCodes = () => (state.index?.leagues || []).filter((l) => safeFile(l.file)).map((l) => l.code);
  const shownCodes = () => (state.selected === 'ALL' ? selectableCodes() : [state.selected]);

  function ensureLeague(code, { force = false } = {}) {
    const known = state.leagues.get(code);
    if (known && !force && (known.status === 'loading' || known.status === 'ok')) return known;
    const meta = leagueMeta(code);
    const file = safeFile(meta?.file);
    const rec = { status: 'loading', data: null, error: null };
    state.leagues.set(code, rec);
    if (!file) {
      rec.status = 'error';
      rec.error = fail('nofile');
      return rec;
    }
    getJson(file)
      .then((data) => {
        if (!data || data.schema !== 1 || !Array.isArray(data.matches) || !data.league?.code) throw fail('format');
        rec.status = 'ok';
        rec.data = data;
      })
      .catch((err) => {
        rec.status = 'error';
        rec.error = err;
      })
      .then(scheduleRender);
    return rec;
  }

  /** report.json, loaded on first use of the reliability view. */
  function ensureReport({ force = false } = {}) {
    const known = state.report;
    if (!force && (known.status === 'loading' || known.status === 'ok')) return known;
    const rec = { status: 'loading', data: null, error: null };
    state.report = rec;
    getJson('report.json')
      .then((data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.leagues !== 'object' || data.leagues === null) throw fail('format');
        if (data.schema !== 1) throw fail(typeof data.schema === 'number' && data.schema > 1 ? 'schema' : 'format');
        rec.status = 'ok';
        rec.data = data;
      })
      .catch((err) => {
        rec.status = 'error';
        rec.error = err;
      })
      .then(scheduleRender);
    return rec;
  }

  // ------------------------------------------------------------ messages --
  function messageCard({ icon, title, text, steps = null, retry = null }) {
    return h(
      'div',
      { class: 'msg', role: 'alert' },
      h('div', { class: 'msg-icon', 'aria-hidden': 'true' }, icon),
      h('h2', null, title),
      text ? h('p', null, text) : null,
      steps ? h('ol', null, steps.map((s) => h('li', null, s))) : null,
      retry ? h('button', { type: 'button', class: 'btn retry', 'data-action': retry.action, 'data-code': retry.code || '' }, retry.label || 'Δοκίμασε ξανά') : null,
    );
  }

  function showFatal(card) {
    $('chips').replaceChildren();
    $('banner').replaceChildren();
    $('app').replaceChildren(card);
    $('app').removeAttribute('aria-busy');
  }

  function configProblem(reason) {
    if (reason === 'missing') {
      return messageCard({
        icon: '⚙️',
        title: 'Λείπει το αρχείο config.js',
        text: 'Η σελίδα δεν βρήκε τις ρυθμίσεις της. Έλεγξε ότι το αρχείο public/config.js υπάρχει στο GitHub repository σου και ότι ο Netlify δημοσιεύει τον φάκελο «public».',
      });
    }
    return messageCard({
      icon: '⚙️',
      title: 'Η εφαρμογή δεν έχει ρυθμιστεί ακόμα',
      text: 'Χρειάζεται να πεις στη σελίδα πού βρίσκονται τα δεδομένα:',
      steps: [
        'Άνοιξε στο GitHub το αρχείο public/config.js και πάτησε το εικονίδιο με το μολύβι.',
        'Στο OWNER γράψε το όνομα χρήστη σου στο GitHub και στο REPO το όνομα του repository.',
        'Πάτησε «Commit changes». Ο Netlify θα ενημερώσει τη σελίδα σε ένα λεπτό.',
      ],
    });
  }

  function loadProblem(err) {
    if (err.kind === 'http' && err.status === 404) {
      return messageCard({
        icon: '📭',
        title: 'Δεν υπάρχουν δεδομένα ακόμα',
        text: 'Ο κλάδος «data» δεν έχει δημιουργηθεί ακόμα ή το OWNER/REPO στο config.js δεν είναι σωστό. Αν είναι η πρώτη φορά: στο GitHub πήγαινε Actions → «Ανανέωση δεδομένων» → Run workflow και περίμενε λίγα λεπτά.',
        retry: { action: 'retry-index' },
      });
    }
    if (err.kind === 'http') {
      return messageCard({
        icon: '⚠️',
        title: 'Το GitHub δεν απάντησε σωστά',
        text: `Σφάλμα HTTP ${err.status}. Συνήθως περνάει μόνο του· δοκίμασε ξανά σε λίγο.`,
        retry: { action: 'retry-index' },
      });
    }
    if (err.kind === 'schema') {
      return messageCard({
        icon: '🔄',
        title: 'Τα δεδομένα είναι σε νεότερη μορφή',
        text: 'Η σελίδα που βλέπεις είναι παλιότερη από τα δεδομένα. Ανανέωσε τη σελίδα (τράβηγμα προς τα κάτω ή Ctrl+F5).',
        retry: { action: 'retry-index', label: 'Ανανέωση' },
      });
    }
    if (err.kind === 'format') {
      return messageCard({
        icon: '⚠️',
        title: 'Τα δεδομένα έχουν απρόσμενη μορφή',
        text: 'Το αρχείο δεδομένων δεν διαβάστηκε σωστά. Αν το πρόβλημα μένει, τρέξε ξανά το workflow «Ανανέωση δεδομένων».',
        retry: { action: 'retry-index' },
      });
    }
    return messageCard({
      icon: '📶',
      title: 'Δεν υπάρχει σύνδεση',
      text: 'Δεν ήταν δυνατή η φόρτωση των δεδομένων. Έλεγξε τη σύνδεσή σου στο διαδίκτυο και δοκίμασε ξανά.',
      retry: { action: 'retry-index' },
    });
  }

  /** A load-problem card whose retry button reloads one league instead of the index. */
  function retargetRetry(card, code) {
    const btn = card.querySelector('.retry');
    if (btn) {
      btn.dataset.action = 'retry-league';
      btn.dataset.code = code;
    }
    return card;
  }

  /** The load-problem card of the reliability view; its retry button reloads report.json only. */
  function reportProblem(err) {
    if (err?.kind === 'http' && err.status === 404) {
      return messageCard({
        icon: '📊',
        title: 'Δεν υπάρχει ακόμα αναφορά αξιοπιστίας',
        text: 'Ο εβδομαδιαίος έλεγχος τρέχει αυτόματα κάθε Δευτέρα. Για να τρέξει τώρα: στο GitHub πήγαινε Actions → «Εβδομαδιαίος έλεγχος αξιοπιστίας» → Run workflow και περίμενε λίγα λεπτά.',
        retry: { action: 'retry-report' },
      });
    }
    const card = loadProblem(err || fail('network'));
    const btn = card.querySelector('.retry');
    if (btn) btn.dataset.action = 'retry-report';
    return card;
  }

  function skeleton() {
    return h(
      'div',
      { class: 'skeleton-list', 'aria-hidden': 'true' },
      [1, 2, 3].map(() => h('div', { class: 'card skeleton' }, h('i', null), h('i', null), h('i', null))),
    );
  }

  // ---------------------------------------------------------------- chips --
  function renderChips() {
    const leagues = state.index.leagues || [];
    const chip = (code, label, { disabled = false, title = null, warn = false } = {}) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          'data-code': code,
          'aria-pressed': code === state.selected ? 'true' : 'false',
          disabled,
          title,
        },
        label,
        warn ? h('span', { class: 'chip-warn', 'aria-label': 'παλιά δεδομένα' }, ' ⚠') : null,
      );
    $('chips').replaceChildren(
      chip('ALL', 'Όλες'),
      ...leagues.map((l) => {
        const usable = Boolean(safeFile(l.file));
        return chip(l.code, l.name, {
          disabled: !usable,
          warn: usable && l.stale,
          title: !usable ? 'Δεν υπάρχουν δεδομένα (πρόβλημα στην πηγή)' : l.stale ? `Παλιά δεδομένα: ${l.staleReason || ''}` : l.country,
        });
      }),
    );
  }

  /** Highlights the selected chip and scrolls it to the middle of the chip row. */
  function markChips() {
    const box = $('chips');
    for (const c of box.querySelectorAll('.chip')) {
      const on = c.dataset.code === state.selected;
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) box.scrollLeft = Math.max(0, c.offsetLeft - (box.clientWidth - c.offsetWidth) / 2);
    }
  }

  // --------------------------------------------------------------- banners --
  function renderBanners(now, loaded) {
    const msgs = [];
    const age = ageHours(state.index.generatedAt, now);
    const globalStale = age === null || age > STALE_AFTER_HOURS;
    if (globalStale) {
      msgs.push({
        tone: 'bad',
        text: `Τα δεδομένα είναι παλιά: τελευταία ενημέρωση ${agoText(age)}. Οι πιθανότητες μπορεί να μην ισχύουν πια. Αν το βλέπεις συχνά, δες το SETUP.md (ενότητα για τις αυτόματες ενημερώσεις).`,
      });
    } else {
      const names = [];
      const reasons = [];
      for (const { league } of loaded) {
        const st = staleInfo(league, now);
        if (st.stale) {
          names.push(league.league.name);
          reasons.push(`${league.league.name}: ${st.reason}`);
        }
      }
      if (names.length) {
        msgs.push({ tone: 'warn', text: `Παλιά δεδομένα για: ${names.join(', ')}. Η πηγή δεν απάντησε και κρατήθηκαν τα τελευταία καλά δεδομένα.`, title: reasons.join('\n') });
      }
    }
    $('banner').replaceChildren(...msgs.map((m) => h('div', { class: `banner ${m.tone}`, role: 'status', title: m.title || null }, m.text)));
  }

  // ------------------------------------------------------------------ list --
  function renderCard(entry, showLeague, now) {
    const key = entry.key;
    const id = safeId(key);
    const open = state.open.has(key);
    state.entries.set(key, entry);
    try {
      const head = h(
        'button',
        { type: 'button', class: 'card-head', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': `pn-${id}`, 'data-key': key },
        views.headContent(entry, { showLeague, now }),
      );
      const panel = h('div', { class: 'panel', id: `pn-${id}`, hidden: !open });
      if (open) panel.append(views.panelContent(entry, state.tabs.get(key) || TABS[0][0], { now }));
      return h('article', { class: `card${open ? ' open' : ''}`, 'data-key': key }, h('h3', { class: 'card-h' }, head), panel);
    } catch {
      return h('article', { class: 'card broken' }, h('p', { class: 'empty' }, `Δεν ήταν δυνατή η εμφάνιση του αγώνα ${entry.m.homeName ?? ''} – ${entry.m.awayName ?? ''}.`));
    }
  }

  function renderReliability() {
    const app = $('app');
    const rec = state.report;
    $('banner').replaceChildren(); // the stale-data banners belong to the matches view
    if (rec.status === 'error') {
      app.replaceChildren(reportProblem(rec.error));
      app.removeAttribute('aria-busy');
      $('status').textContent = '';
      return;
    }
    if (rec.status !== 'ok') {
      app.replaceChildren(skeleton());
      app.setAttribute('aria-busy', 'true');
      $('status').textContent = '';
      return;
    }
    app.replaceChildren(...reliability.reportContent(rec.data, { now: nowFn() }));
    app.removeAttribute('aria-busy');
    $('status').textContent = 'Αναφορά αξιοπιστίας';
  }

  function renderMain() {
    state.renderQueued = false;
    if (!state.index) return;
    if (state.view === 'reliability') return renderReliability();
    const now = nowFn();
    const codes = shownCodes();
    const loaded = [];
    const pending = [];
    const failed = [];
    codes.forEach((code, order) => {
      const rec = state.leagues.get(code) || ensureLeague(code);
      const meta = leagueMeta(code);
      if (rec.status === 'ok') loaded.push({ league: rec.data, order });
      else if (rec.status === 'loading') pending.push(meta?.name || code);
      else failed.push({ code, name: meta?.name || code, err: rec.error });
    });

    renderBanners(now, loaded);
    const entries = collectEntries(loaded, now);
    state.entries.clear();
    const nodes = [];

    for (const f of failed) {
      const nofile = f.err?.kind === 'nofile';
      nodes.push(
        h(
          'div',
          { class: 'banner warn', role: 'status' },
          nofile
            ? `${f.name}: δεν υπάρχουν δεδομένα αυτή τη στιγμή (πρόβλημα στην πηγή).`
            : `${f.name}: δεν φορτώθηκε${f.err?.kind === 'http' ? ` (HTTP ${f.err.status})` : ' (πρόβλημα σύνδεσης)'}. `,
          nofile ? null : h('button', { type: 'button', class: 'link retry', 'data-action': 'retry-league', 'data-code': f.code }, 'Δοκίμασε ξανά'),
        ),
      );
    }
    if (pending.length > 0 && loaded.length > 0) nodes.push(h('p', { class: 'loading-note' }, `Φορτώνονται ακόμα: ${pending.join(', ')}…`));

    if (loaded.length === 0 && pending.length > 0) {
      nodes.push(skeleton());
    } else if (loaded.length === 0 && failed.length > 0) {
      // Nothing could be loaded at all: explain the first problem and offer a retry.
      const first = failed[0].err || fail('network');
      const card = loadProblem(first.kind === 'nofile' ? fail('format') : first);
      nodes.push(state.selected === 'ALL' ? card : retargetRetry(card, failed[0].code));
    } else if (entries.length === 0) {
      nodes.push(
        messageCard({
          icon: '📅',
          title: 'Δεν υπάρχουν αγώνες τις επόμενες 7 ημέρες',
          text: 'Μπορεί να υπάρχει διακοπή του πρωταθλήματος (π.χ. αγώνες εθνικών ομάδων). Δοκίμασε άλλο πρωτάθλημα ή έλα αργότερα.',
        }),
      );
    } else {
      const today = athensDay(now);
      const showLeague = state.selected === 'ALL';
      for (const g of groupByDay(entries)) {
        nodes.push(
          h(
            'section',
            { class: 'day' },
            h('h2', { class: 'day-h' }, dayHeading(g.day, today)),
            g.entries.map((e) => renderCard(e, showLeague, now)),
          ),
        );
      }
    }

    const app = $('app');
    app.replaceChildren(...nodes);
    if (pending.length === 0) app.removeAttribute('aria-busy');
    else app.setAttribute('aria-busy', 'true');
    $('status').textContent = pending.length === 0 ? `${entries.length} αγώνες` : '';
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    Promise.resolve().then(renderMain);
  }

  // --------------------------------------------------------------- actions --
  function select(code, { push = true } = {}) {
    state.selected = code;
    markChips();
    storage.set(STORE_LEAGUE, code);
    if (push) {
      try {
        win.history.replaceState(null, '', code === 'ALL' ? win.location.pathname + win.location.search : `#${code}`);
      } catch {
        /* history not available: the view still works */
      }
    }
    for (const c of shownCodes()) ensureLeague(c);
    renderMain();
    try {
      win.scrollTo(0, 0);
    } catch {
      /* not supported */
    }
  }

  /** Buttons "Αγώνες | Αξιοπιστία" and the league chips follow the current view. */
  function applyViewUi() {
    const rel = state.view === 'reliability';
    for (const b of $('views')?.querySelectorAll('.view-btn') || []) b.setAttribute('aria-pressed', b.dataset.view === state.view ? 'true' : 'false');
    const nav = $('league-nav');
    if (nav) nav.hidden = rel;
  }

  function setView(view, { push = true } = {}) {
    state.view = view === 'reliability' ? 'reliability' : 'matches';
    applyViewUi();
    if (push) {
      try {
        const keep = state.selected === 'ALL' ? win.location.pathname + win.location.search : `#${state.selected}`;
        win.history.replaceState(null, '', state.view === 'reliability' ? '#reliability' : keep);
      } catch {
        /* history not available: the view still works */
      }
    }
    if (state.view === 'reliability') ensureReport();
    else for (const c of shownCodes()) ensureLeague(c);
    renderMain();
    try {
      win.scrollTo(0, 0);
    } catch {
      /* not supported */
    }
  }

  function onViewClick(ev) {
    const btn = ev.target.closest ? ev.target.closest('.view-btn') : null;
    if (btn && btn.dataset.view !== state.view) setView(btn.dataset.view);
  }

  /** The URL hash decides the view: #reliability, or a league code / nothing for the matches. */
  function applyHash() {
    if (parseView(win.location.hash) === 'reliability') {
      if (state.view !== 'reliability') setView('reliability', { push: false });
      return;
    }
    state.view = 'matches';
    applyViewUi();
    select(parseHash(win.location.hash, selectableCodes()), { push: false });
  }

  function toggleCard(card) {
    const key = card.dataset.key;
    const entry = state.entries.get(key);
    if (!entry) return;
    const head = card.querySelector('.card-head');
    const panel = card.querySelector('.panel');
    const open = !state.open.has(key);
    if (open) {
      state.open.add(key);
      if (!panel.firstChild) panel.append(views.panelContent(entry, state.tabs.get(key) || TABS[0][0], { now: nowFn() }));
    } else {
      state.open.delete(key);
    }
    panel.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    card.classList.toggle('open', open);
  }

  /** Only the tab panel is rebuilt; the tab buttons stay, so keyboard focus is kept. */
  function switchTab(card, tabId, { focus = false } = {}) {
    const key = card.dataset.key;
    const entry = state.entries.get(key);
    if (!entry) return;
    state.tabs.set(key, tabId);
    const tp = card.querySelector('.tp');
    tp.replaceChildren(...views.tabContent(tabId, entry, { now: nowFn() }));
    for (const t of card.querySelectorAll('.tab')) {
      const on = t.dataset.tab === tabId;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
      if (on) {
        tp.setAttribute('aria-labelledby', t.id);
        if (focus) t.focus();
      }
    }
  }

  function onClick(ev) {
    const target = ev.target.closest ? ev.target : ev.target.parentElement;
    if (!target) return;
    const retry = target.closest('.retry');
    if (retry) {
      if (retry.dataset.action === 'retry-index') reloadAll();
      else if (retry.dataset.action === 'retry-report') {
        ensureReport({ force: true });
        renderMain();
      } else if (retry.dataset.action === 'retry-league') {
        ensureLeague(retry.dataset.code, { force: true });
        renderMain();
      }
      return;
    }
    const tab = target.closest('.tab');
    if (tab) return switchTab(tab.closest('.card'), tab.dataset.tab);
    const head = target.closest('.card-head');
    if (head) toggleCard(head.closest('.card'));
  }

  function onKey(ev) {
    const tab = ev.target.closest ? ev.target.closest('.tab') : null;
    if (!tab) return;
    const tabs = [...tab.parentElement.querySelectorAll('.tab')];
    const i = tabs.indexOf(tab);
    let next = null;
    if (ev.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (ev.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (ev.key === 'Home') next = tabs[0];
    else if (ev.key === 'End') next = tabs[tabs.length - 1];
    if (next) {
      ev.preventDefault();
      switchTab(tab.closest('.card'), next.dataset.tab, { focus: true });
    }
  }

  function onChip(ev) {
    const chip = ev.target.closest ? ev.target.closest('.chip') : null;
    if (chip && !chip.disabled) select(chip.dataset.code);
  }

  // ----------------------------------------------------------------- footer --
  function renderFooter() {
    const gen = new Date(state.index.generatedAt);
    $('updated').textContent = Number.isNaN(gen.getTime())
      ? 'Τελευταία ενημέρωση: άγνωστη'
      : `Τελευταία ενημέρωση: ${formatStamp(gen)} (ώρα Ελλάδας)`;
    $('updated').hidden = false;
    // Credits and notes that only apply when the feature is in the data
    const apif = state.index.sources?.apiFootball?.status;
    const usesApif = apif === 'ok' || apif === 'stale';
    if ($('credit-apif')) $('credit-apif').hidden = !usesApif;
    if ($('foot-absences')) $('foot-absences').hidden = !usesApif;
    if ($('foot-cl')) $('foot-cl').hidden = !state.index.leagues.some((l) => l && l.eloOnly);
    const warnings = Array.isArray(state.index.warnings) ? state.index.warnings.filter((w) => w && w.message) : [];
    const box = $('warnings');
    box.hidden = warnings.length === 0;
    $('warnings-count').textContent = String(warnings.length);
    $('warnings-list').replaceChildren(...warnings.map((w) => h('li', null, w.message)));
  }

  // --------------------------------------------------------------- theme --
  function currentTheme() {
    const set = doc.documentElement.dataset.theme;
    if (set === 'dark' || set === 'light') return set;
    return win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function paintThemeButton() {
    const btn = $('theme');
    if (!btn) return;
    const dark = currentTheme() === 'dark';
    btn.textContent = dark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', dark ? 'Αλλαγή σε φωτεινό θέμα' : 'Αλλαγή σε σκούρο θέμα');
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    doc.documentElement.dataset.theme = next;
    storage.set(STORE_THEME, next);
    paintThemeButton();
  }

  // ------------------------------------------------------------------ boot --
  async function loadIndex() {
    $('app').setAttribute('aria-busy', 'true');
    $('app').replaceChildren(skeleton());
    $('banner').replaceChildren();
    let index;
    try {
      index = await getJson('index.json');
    } catch (err) {
      return showFatal(loadProblem(err));
    }
    if (!index || !Array.isArray(index.leagues)) return showFatal(loadProblem(fail('format')));
    if (index.schema !== 1) return showFatal(loadProblem(fail('schema')));
    state.index = index;
    state.leagues.clear();
    renderChips();
    renderFooter();
    if (index.leagues.length === 0) {
      return showFatal(messageCard({ icon: '📭', title: 'Δεν υπάρχουν πρωταθλήματα', text: 'Το αρχείο δεδομένων δεν περιέχει κανένα πρωτάθλημα. Έλεγξε το τελευταίο τρέξιμο στο GitHub Actions.' }));
    }
    const codes = selectableCodes();
    const fromHash = parseHash(win.location.hash, codes);
    const saved = storage.get(STORE_LEAGUE);
    const initial = fromHash !== 'ALL' ? fromHash : codes.includes(saved) ? saved : 'ALL';
    if (parseView(win.location.hash) === 'reliability') {
      state.selected = initial; // the league to come back to
      markChips();
      setView('reliability', { push: false });
    } else {
      state.view = 'matches';
      applyViewUi();
      select(initial, { push: false });
    }
  }

  function reloadAll() {
    state.open.clear();
    state.tabs.clear();
    state.report = { status: 'idle', data: null, error: null };
    return loadIndex();
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') {
      state.hiddenAt = Date.now();
    } else if (state.index) {
      // A page left open for hours: hide matches that started and refresh the data.
      if (state.hiddenAt && Date.now() - state.hiddenAt > RELOAD_AFTER_HIDDEN_MS) reloadAll();
      else renderMain();
    }
  }

  async function start() {
    const savedTheme = storage.get(STORE_THEME);
    if (savedTheme === 'dark' || savedTheme === 'light') doc.documentElement.dataset.theme = savedTheme;
    paintThemeButton();
    $('theme')?.addEventListener('click', toggleTheme);
    $('chips').addEventListener('click', onChip);
    $('views')?.addEventListener('click', onViewClick);
    $('app').addEventListener('click', onClick);
    $('app').addEventListener('keydown', onKey);
    $('banner').addEventListener('click', onClick);
    win.addEventListener('hashchange', () => {
      if (state.index) applyHash();
    });
    doc.addEventListener('visibilitychange', onVisibility);

    const base = dataBase(config);
    if (!base.ok) return showFatal(configProblem(base.reason));
    state.base = base.base;
    await loadIndex();
  }

  return { start, state, select, setView, reloadAll, renderMain };
}

// Start automatically in the browser (tests set window.__FP_NO_AUTOSTART first).
if (typeof window !== 'undefined' && window.document && window.document.getElementById('app') && !window.__FP_NO_AUTOSTART) {
  createApp().start();
}
