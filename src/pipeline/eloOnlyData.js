// Data for the Elo-only model of the Champions League: the rows of the pooled domestic regression.
//
// Every domestic match since the start of the season two years back gets the ClubElo rating of both teams from
// the monthly snapshot valid on its day (at most 62 days old) and the usual time weight exp(-xi * age).
// Matches where either team has no rating are left out, never guessed.

import { seasonStartYear } from '../config.js';
import { timeWeight } from '../model/dc.js';
import { ELO_DIV } from '../model/eloOnly.js';

const DAY_MS = 86400000;

/** First day of the pooled sample: 1 July of the season two years before the current one. */
export function pooledFromDay(now) {
  return Date.UTC(seasonStartYear(now) - 2, 6, 1) / DAY_MS;
}

/**
 * @param {{code:string, history:object[], eloAt:(day:number)=>Map<string,number>|null}[]} domestic
 *        history rows: { t, home, away, x, y } with resolved team keys
 * @returns {{rows: {x:number,y:number,d:number,w:number}[], leagues: Record<string, {matches:number, used:number}>, used:number, matches:number}}
 */
export function pooledRows({ domestic, tNow, xi, fromDay }) {
  const rows = [];
  const leagues = {};
  let matches = 0;
  for (const { code, history, eloAt } of domestic) {
    const stat = { matches: 0, used: 0 };
    leagues[code] = stat;
    for (const m of history) {
      if (!(m.t >= fromDay && m.t < tNow)) continue;
      if (!Number.isInteger(m.x) || !Number.isInteger(m.y)) continue;
      stat.matches++;
      const map = eloAt(m.t);
      const eh = map?.get(m.home);
      const ea = map?.get(m.away);
      if (eh === undefined || ea === undefined) continue;
      stat.used++;
      rows.push({ x: m.x, y: m.y, d: (eh - ea) / ELO_DIV, w: timeWeight(m.t, tNow, xi) });
    }
    matches += stat.matches;
  }
  return { rows, leagues, used: rows.length, matches };
}
