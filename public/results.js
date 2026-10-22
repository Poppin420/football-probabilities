// View "Αποτελέσματα" (data: scorecard.json, field "recent"): finished matches with the forecast the page showed
// before the match and what really happened. Only createElement / textContent are used (team and league names come
// from a data file). Every number is read defensively: the file may come from an older version of the job.

import { athensDay, dayHeading } from './util.js';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const KEYS = ['home', 'draw', 'away'];
const pc = (x) => `${Math.round(x * 100)}%`;

export function createResults(h) {
  const empty = (text) => h('p', { class: 'empty' }, text);

  function forecastBar(p, outcome) {
    return h(
      'div',
      { class: 'res-bar', role: 'img', 'aria-label': `Πιθανότητες: νίκη γηπεδούχου ${pc(p[0])}, ισοπαλία ${pc(p[1])}, νίκη φιλοξενούμενου ${pc(p[2])}` },
      KEYS.map((k, i) => h('span', { class: `res-seg${i === outcome ? ' hit' : ''}`, style: `flex-grow:${Math.max(p[i], 0.02)}` }, pc(p[i]))),
    );
  }

  function matchRow(m, names) {
    const p = m.p;
    const outcome = m.x > m.y ? 0 : m.x === m.y ? 1 : 2;
    const fav = p.indexOf(Math.max(...p));
    const right = fav === outcome;
    return h(
      'article',
      { class: 'res-card' },
      h(
        'div',
        { class: 'res-head' },
        h('span', { class: 'res-league' }, names[m.code] || m.code),
        h('span', { class: `res-verdict ${right ? 'ok' : 'miss'}` }, right ? 'Το φαβορί βγήκε ✓' : 'Το φαβορί δεν βγήκε ✗'),
      ),
      h('div', { class: 'res-teams' }, h('span', null, m.names[0]), h('b', { class: 'res-score' }, `${m.x}–${m.y}`), h('span', null, m.names[1])),
      forecastBar(p, outcome),
    );
  }

  /** @param {object|null} sc scorecard.json  @param {{names:Object<string,string>, now:Date}} opts */
  function resultsContent(sc, { names = {}, now }) {
    const out = [h('h2', { class: 'rel-h' }, 'Αποτελέσματα και προβλέψεις')];
    out.push(
      h(
        'p',
        { class: 'rel-lead' },
        'Εδώ φαίνονται οι αγώνες που έχουν τελειώσει, με την πρόβλεψη που είχαμε δείξει πριν από τον αγώνα. Η πρόβλεψη αποθηκεύεται πριν ξεκινήσει ο αγώνας και δεν αλλάζει μετά.',
      ),
    );
    const list = sc && sc.schema === 1 && Array.isArray(sc.recent) ? sc.recent.filter((m) => m && Array.isArray(m.p) && m.p.length === 3 && m.p.every(finite) && Array.isArray(m.names) && Number.isInteger(m.x) && Number.isInteger(m.y) && typeof m.kickoff === 'string' && Number.isFinite(Date.parse(m.kickoff))) : [];
    if (list.length === 0) {
      out.push(empty(sc ? `Δεν υπάρχουν ακόμα τελειωμένοι αγώνες με καταγεγραμμένη πρόβλεψη${finite(sc.pending) && sc.pending > 0 ? ` (${sc.pending} περιμένουν να παιχτούν ή να βγει το αποτέλεσμά τους)` : ''}. Θα εμφανιστούν μόλις τελειώσουν οι πρώτοι αγώνες.` : 'Δεν υπάρχουν ακόμα δεδομένα αποτελεσμάτων. Θα εμφανιστούν μετά το επόμενο «Ανανέωση δεδομένων» και τους πρώτους αγώνες.'));
      return out;
    }
    const right = list.filter((m) => m.p.indexOf(Math.max(...m.p)) === (m.x > m.y ? 0 : m.x === m.y ? 1 : 2)).length;
    out.push(h('p', { class: 'note' }, `Τελευταίοι ${list.length} αγώνες: το φαβορί του μοντέλου βγήκε σε ${right} (${Math.round((right / list.length) * 100)}%). Το ποσοστό αυτό από μόνο του δεν δείχνει πόσο καλές είναι οι πιθανότητες· δες την «Αξιοπιστία» για βαθμονόμηση και μακροπρόθεσμα νούμερα.`));
    const today = athensDay(now);
    let day = null;
    for (const m of list) {
      const d = new Date(m.kickoff);
      const key = athensDay(d);
      if (key !== day) {
        day = key;
        out.push(h('h2', { class: 'day-h' }, dayHeading(key, today)));
      }
      out.push(matchRow(m, names));
    }
    return out;
  }

  return { resultsContent };
}
