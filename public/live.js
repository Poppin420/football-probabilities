// The side panel "Παίζουν τώρα": matches being played (or just finished) with their score, the model's
// forecast from before the match and whether the most probable result is what the match shows right now.
// The data (live.json) comes from football-data.org's free plan, which delays scores a little: "almost live".

import { favouriteOf, liveVerdict, outcomeOfScore, pctSet } from './util.js';

const DASH = '–';
const SYMBOL = { home: '1', draw: 'Χ', away: '2' };

export function createLive(h) {
  const stateText = (m) => {
    if (m.state === 'finished') return 'Τέλος';
    if (m.state === 'half-time') return 'Ημίχρονο';
    return Number.isInteger(m.minute) ? `${m.minute}'${Number.isInteger(m.injuryTime) && m.injuryTime > 0 ? `+${m.injuryTime}` : ''}` : 'Παίζεται';
  };
  const scoreText = (m) => (Number.isInteger(m.score?.home) && Number.isInteger(m.score?.away) ? `${m.score.home}${DASH}${m.score.away}` : `0${DASH}0`);

  /** forecast: the match object from <LEAGUE>.json (or null when the match is not in it). */
  function verdictLine(m, forecast) {
    const x = forecast?.goals?.oneX2;
    const fav = favouriteOf(x);
    if (!fav) return h('p', { class: 'lv-note' }, 'Δεν υπάρχει πρόβλεψη του μοντέλου για αυτόν τον αγώνα.');
    const name = fav.key === 'home' ? forecast.homeName : fav.key === 'away' ? forecast.awayName : 'ισοπαλία';
    const verdict = liveVerdict(fav, { home: m.score?.home, away: m.score?.away }, m.state);
    const [ph, pd, pa] = pctSet([x.home, x.draw, x.away]);
    const shown = { home: ph, draw: pd, away: pa }[fav.key];
    const label = fav.key === 'draw' ? 'Φαβορί: ισοπαλία' : `Φαβορί: ${name}`;
    const text =
      verdict === 'won' ? 'βγήκε ✓' : verdict === 'lost' ? 'δεν βγήκε ✗' : verdict === 'on' ? 'βγαίνει τώρα ✓' : verdict === 'off' ? 'δεν βγαίνει τώρα' : '';
    return h(
      'p',
      { class: `lv-verdict ${verdict || ''}` },
      h('span', { class: 'lv-fav' }, `${label} (${SYMBOL[fav.key]} ${shown})`),
      text ? h('b', null, text) : null,
    );
  }

  function card(m, forecast) {
    const x = forecast?.goals?.oneX2;
    const [ph, pd, pa] = x ? pctSet([x.home, x.draw, x.away]) : [null, null, null];
    return h(
      'li',
      { class: `lv-card ${m.state}`, 'data-id': String(m.id) },
      h('div', { class: 'lv-top' }, h('span', { class: 'lv-comp' }, m.competition || m.code || ''), h('b', { class: 'lv-state' }, stateText(m))),
      h('div', { class: 'lv-score' }, h('span', { class: 'lv-t' }, m.home), h('b', { class: 'lv-s' }, scoreText(m)), h('span', { class: 'lv-t' }, m.away)),
      x ? h('p', { class: 'lv-probs', 'aria-label': 'Πρόβλεψη πριν τον αγώνα' }, `1 ${ph} · Χ ${pd} · 2 ${pa}`) : null,
      verdictLine(m, forecast),
    );
  }

  /**
   * @param {HTMLElement} panel  the <aside>
   * @param {{matches:object[], updatedAt:string}|null} live
   * @param {(code:string, id:number) => object|null} lookup  the forecast of a match, from the loaded league files
   */
  function render(panel, live, lookup, { stale = false } = {}) {
    const list = Array.isArray(live?.matches) ? live.matches : [];
    panel.hidden = list.length === 0;
    if (list.length === 0) {
      panel.replaceChildren();
      return;
    }
    const playing = list.filter((m) => m.state !== 'finished').length;
    const upd = live.updatedAt ? new Date(live.updatedAt) : null;
    const time = upd && !Number.isNaN(upd.getTime()) ? upd.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Athens' }) : null;
    panel.replaceChildren(
      h('details', { class: 'lv-box', open: true },
        h('summary', null, h('span', { class: `lv-dot${playing ? ' on' : ''}`, 'aria-hidden': 'true' }), `Παίζουν τώρα (${playing})`),
        h('ul', { class: 'lv-list' }, list.map((m) => card(m, lookup(m.code, m.id)))),
        h('p', { class: 'lv-foot' }, time ? `Ενημέρωση ${time}` : '', ' · με μικρή καθυστέρηση (δωρεάν πηγή)', stale ? ' · η τελευταία ενημέρωση άργησε' : ''),
      ),
    );
  }

  return { render, card, stateText, scoreText, outcomeOfScore };
}
