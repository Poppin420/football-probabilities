// Data for our own Elo (src/model/ownElo.js): turns the domestic CSV rows and the finished Champions League
// matches into ONE chronological series, runs the engine and returns ClubElo-shaped snapshots, so the rest of the
// pipeline (league Elo prior, Champions League model, weekly tuning) uses them exactly like the downloaded ones.

import { dayNumber, isoDate } from '../config.js';
import { monthStarts } from './eloSnapshots.js';
import { runOwnElo } from '../model/ownElo.js';

/**
 * @param {object} p
 * @param {{league:{code:string,div:string,eloCountry:string,eloLevel:number}, rows:object[]}[]} p.leagueRows  CSV rows (all seasons read)
 * @param {{season?:string, results:object[]}[]} p.cupParts  finished Champions League matches (parseResults() rows), any seasons
 * @param {object} p.resolver
 * @param {Date} p.now
 * @param {number} p.fromDay first day for which monthly snapshots are wanted
 * @returns {{snaps:Map<string,object[]>, current:{date:string,fetchedAt:string,source:'own',clubs:object[]}, info:object}}
 */
export function buildOwnElo({ leagueRows, cupParts = [], resolver, now, fromDay }) {
  const tNow = dayNumber(now);
  const matches = [];
  const domesticKeys = new Set();
  const perLeague = {};
  for (const { league, rows } of leagueRows) {
    let used = 0;
    for (const r of rows) {
      const home = resolver.key(r.home);
      const away = resolver.key(r.away);
      domesticKeys.add(home);
      domesticKeys.add(away);
      if (!(r.t < tNow)) continue;
      matches.push({ t: r.t, home, away, x: r.x, y: r.y, group: league.div, country: league.eloCountry, level: league.eloLevel ?? 1 });
      used++;
    }
    perLeague[league.code] = used;
  }
  let cupMatches = 0;
  let cupNoScore = 0;
  const cupOnly = new Set();
  const keyOf = (team) => {
    const m = resolver.matchAny([team.name, team.shortName], domesticKeys);
    if (m.key) return m.key;
    const k = resolver.key(team.name);
    cupOnly.add(k);
    return k;
  };
  const seen = new Set();
  for (const part of cupParts) {
    for (const r of part.results) {
      if (r.id !== undefined) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      const ko = Date.parse(r.kickoff);
      if (!(ko < now.getTime())) continue;
      if (!Number.isInteger(r.x) || !Number.isInteger(r.y)) {
        cupNoScore++;
        continue;
      }
      matches.push({ t: dayNumber(new Date(ko)), home: keyOf(r.home), away: keyOf(r.away), x: r.x, y: r.y, group: 'CL', neutral: r.stage === 'FINAL' });
      cupMatches++;
    }
  }
  const dates = monthStarts(fromDay, tNow);
  const res = runOwnElo({ matches, snapshotDates: dates, tNow });
  return {
    snaps: res.snapshots,
    current: { date: isoDate(now), fetchedAt: now.toISOString(), source: 'own', clubs: res.current },
    info: {
      matches: res.matches,
      clubs: res.clubs,
      leagues: perLeague,
      cupMatches,
      cupNoScore,
      cupOnlyClubs: cupOnly.size,
      snapshots: dates.length,
    },
  };
}
