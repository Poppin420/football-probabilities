// The live panel: which matches are being played right now (or finished a moment ago).
//
// One request to football-data.org, a few lines of selection, and a tiny live.json that goes to the branch "live".
// No maths here: the probabilities of a match are already in <LEAGUE>.json (matched by the match id in the page).
// The free plan delivers scores with a delay, so the panel is "almost live", not real time.

import { isoDate } from '../config.js';

const LIVE_STATUSES = new Set(['IN_PLAY', 'PAUSED', 'LIVE']);
const KEEP_FINISHED_MS = 3 * 3600 * 1000; // a finished match stays in the panel until 3 hours after kick-off
const DAY_MS = 86400000;

/** The dates asked from the API: yesterday .. tomorrow (a late match crosses midnight UTC). */
export function liveWindow(now) {
  return { from: isoDate(new Date(now.getTime() - DAY_MS)), to: isoDate(new Date(now.getTime() + DAY_MS)) };
}

/** Pick the matches for the panel: being played now, or finished less than 3 hours after kick-off. */
export function selectLive(matches, now) {
  const t = now.getTime();
  const out = [];
  for (const m of matches) {
    const ko = Date.parse(m.kickoff);
    if (LIVE_STATUSES.has(m.status)) out.push({ ...m, state: m.status === 'PAUSED' ? 'half-time' : 'live' });
    else if (m.status === 'FINISHED' && t - ko >= 0 && t - ko < KEEP_FINISHED_MS) out.push({ ...m, state: 'finished' });
  }
  out.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id - b.id);
  return out.map((m) => ({
    id: m.id,
    code: m.code,
    competition: m.competition,
    state: m.state,
    minute: m.minute,
    injuryTime: m.injuryTime,
    kickoff: m.kickoff,
    home: m.home.shortName || m.home.name,
    away: m.away.shortName || m.away.name,
    homeFull: m.home.name,
    awayFull: m.away.name,
    score: m.score,
  }));
}

export function buildLiveFile(matches, now) {
  return { schema: 1, updatedAt: now.toISOString(), matches: selectLive(matches, now) };
}

/** Same matches and scores as before (the update time is ignored): nothing new to publish. */
export function sameLive(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a.matches) === JSON.stringify(b.matches);
}
