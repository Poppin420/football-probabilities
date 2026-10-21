// Which cache entries of the "data" branch are still worth keeping.
// The daily refresh and the weekly tuning both rebuild the branch from the
// previous content, so each of them carries over the entries the OTHER one
// created (older CSV seasons and the monthly ClubElo snapshots of the tuning).

import { seasonStartYear } from '../config.js';

const DAY_MS = 86400000;
export const EVAL_SEASONS = 2; // the tuning evaluates the last 2 completed seasons
export const SEASONS_BACK = 3; // ... each trained on up to 3 earlier seasons

/** Oldest season the tuning needs: current - 2 (first evaluated) - 3 (its training window). */
export function oldestSeasonNeeded(now) {
  return seasonStartYear(now) - EVAL_SEASONS - SEASONS_BACK;
}

/** First day (ms) of the monthly Elo snapshots worth keeping. */
export function eloKeepFrom(now) {
  return Date.UTC(seasonStartYear(now) - EVAL_SEASONS, 6, 1) - 62 * DAY_MS;
}

export function keepCacheName(name, now) {
  let m = /^csv-[A-Za-z0-9]+-(\d{2})(\d{2})$/.exec(name);
  if (m) return 2000 + Number(m[1]) >= oldestSeasonNeeded(now);
  m = /^elo-(\d{4}-\d{2}-\d{2})$/.exec(name);
  if (m) return Date.parse(m[1]) >= eloKeepFrom(now);
  // finished Champions League matches: the own-Elo history reads the last 5 seasons, the weekly tuning needs them too
  m = /^cup-results-[A-Za-z0-9]+-(\d{4})$/.exec(name);
  if (m) return Number(m[1]) >= seasonStartYear(now) - EVAL_SEASONS - SEASONS_BACK;
  if (name === 'apif-usage') return true; // the API-Football request counter of the day must survive a run that does not touch it
  return false; // "elo", "scorers-*", "apif-extras": owned by the daily refresh, which rewrites them itself
}
