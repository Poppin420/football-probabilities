// Monthly ClubElo snapshots, shared by the weekly tuning (Elo prior back-test) and the daily
// refresh (pooled Elo-only regression of the Champions League).
//
// One snapshot per month start is cached in the data branch as cache/elo-YYYY-MM-DD.json.gz.
// Stored: every club of the league countries plus every club of a top-two division in any country
// (the Champions League opponents). Entries written before Phase 3 hold the league countries only
// (no `scope` field) and are downloaded again once.

import { RATE, dayNumberFromIso } from '../config.js';
import { eloForTeams } from '../model/elo.js';

const DAY_MS = 86400000;
export const SNAPSHOT_SCOPE = 2;
export const SNAPSHOT_MAX_AGE_DAYS = 62; // a rating older than this is not used for a match day

/** ISO dates of the first day of each month from the month before `fromDay` to `toDay`. */
export function monthStarts(fromDay, toDay) {
  const out = [];
  const a = new Date((fromDay - 31) * DAY_MS);
  let y = a.getUTCFullYear();
  let m = a.getUTCMonth();
  for (;;) {
    const iso = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    if (dayNumberFromIso(iso) > toDay) break;
    out.push(iso);
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** The clubs worth keeping from a snapshot. */
export function keepClub(c, countries) {
  return countries.has(c.country) || (Number.isFinite(c.level) && c.level <= 2);
}

/**
 * Download (or read from the cache) the snapshots of `dates`.
 * @returns {{snaps: Map<string, {club:string,country:string,level:number|null,elo:number}[]>, downloads:number, failed:number}}
 */
export async function loadEloSnapshots({ dates, countries, cache, now, logger, sleepFn, fetchElo, deadline }) {
  const snaps = new Map();
  let downloads = 0;
  let failed = 0;
  for (const date of dates) {
    const name = `elo-${date}`;
    const cached = cache.peek(name);
    if (cached?.clubs?.length && cached.scope === SNAPSHOT_SCOPE) {
      snaps.set(date, cached.clubs);
      cache.put(name, cached);
      continue;
    }
    if (Date.now() > deadline) {
      failed++;
      if (cached?.clubs?.length) {
        // an old narrow snapshot is still better than none for the leagues; keep it for the next run
        snaps.set(date, cached.clubs);
        cache.put(name, cached);
      }
      continue;
    }
    try {
      if (downloads++ > 0) await sleepFn(RATE.csvPauseMs);
      const snap = await fetchElo(date);
      const clubs = snap.clubs
        .filter((c) => keepClub(c, countries))
        .map((c) => ({ club: c.club, country: c.country, level: Number.isFinite(c.level) ? c.level : null, elo: c.elo }));
      if (clubs.length === 0) throw new Error('no clubs of the wanted countries');
      cache.put(name, { date, fetchedAt: now.toISOString(), scope: SNAPSHOT_SCOPE, clubs });
      snaps.set(date, clubs);
    } catch (err) {
      failed++;
      logger.error(`[ClubElo] ${date}: ${err.message}`);
      if (cached?.clubs?.length) {
        snaps.set(date, cached.clubs);
        cache.put(name, cached);
      }
    }
  }
  return { snaps, downloads, failed };
}

/**
 * Elo (team key -> rating) valid on a day: the latest monthly snapshot not after it, at most 62 days old.
 * country: only the clubs of that country (a domestic league), or null for all clubs (Champions League).
 * teamKeys: optional set of keys of the league's own spelling; each gets one fuzzy attempt against the Elo
 * names (accepted only when unique, see eloForTeams) and is added to the map under ITS key.
 * @returns {(day:number) => Map<string, number>|null}
 */
export function makeEloAt({ snaps, country = null, resolver, teamKeys = null }) {
  const dates = [...snaps.keys()].sort();
  const memo = new Map();
  return (day) => {
    const iso = new Date(day * DAY_MS).toISOString().slice(0, 10);
    let pick = null;
    for (const d of dates) {
      if (d <= iso) pick = d;
      else break;
    }
    if (!pick || day - dayNumberFromIso(pick) > SNAPSHOT_MAX_AGE_DAYS) return null;
    if (!memo.has(pick)) {
      const best = new Map(); // key -> { elo, level }
      for (const c of snaps.get(pick)) {
        if (country && c.country !== country) continue;
        const k = resolver.key(c.club);
        const level = Number.isFinite(c.level) ? c.level : 9;
        const old = best.get(k);
        if (!old || level < old.level || (level === old.level && c.elo > old.elo)) best.set(k, { elo: c.elo, level });
      }
      let m = new Map([...best].map(([k, v]) => [k, v.elo]));
      if (teamKeys && m.size > 0) {
        const { map } = eloForTeams({ teamKeys, eloByKey: m, resolver });
        m = new Map([...m, ...map]);
      }
      memo.set(pick, m);
    }
    const m = memo.get(pick);
    return m.size > 0 ? m : null;
  };
}
