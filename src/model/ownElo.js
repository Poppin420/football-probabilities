// Our own Elo ratings, computed from match results (replaces the ClubElo download, which has been down).
//
// Approved formulas (the classic football Elo of eloratings.net / ClubElo):
//   We = 1 / (1 + 10^(-(dR + H) / 400))            expected score of the home side, dR = R_home - R_away
//   R' = R + K * G * (W - We)                       W = 1 win, 0.5 draw, 0 loss
//   K = 20, H = 100 (home side; 0 on neutral ground), start rating 1500
//   G = 1 (goal difference <= 1), 1.5 (2), (11 + N) / 8 (N >= 3)
// A club that has no earlier match starts at (mean rating of its league) - 100, a club that only plays in the
// Champions League at (mean rating of all clubs) - 100. The first clubs of a league (first 40 days of its
// series) all start at 1500. All matches go through ONE chronological series, so the countries are linked only
// through the Champions League matches.
//
// Pure functions, no I/O. Clubs are identified by the caller's canonical key (resolver.key()).

export const ELO = Object.freeze({
  K: 20,
  HOME: 100,
  START: 1500,
  NEWCOMER_OFFSET: -100,
  MIN_MATCHES: 6, // a club with fewer matches in the history is not rated well enough for a prediction
  LEAGUE_OPEN_DAYS: 40, // clubs that appear in the first 40 days of a league's series start at START
  MIN_PEERS: 8, // a league/pool mean needs at least this many rated clubs
  ACTIVE_DAYS: 400, // a club that has not played for this long is dropped from the snapshots
});

const DAY_MS = 86400000;
const isoOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Goal-difference multiplier G. */
export function goalMultiplier(diff) {
  const d = Math.abs(diff);
  if (d <= 1) return 1;
  if (d === 2) return 1.5;
  return (11 + d) / 8;
}

/** Expected score of the home side. */
export function expectedScore(dR, home = ELO.HOME) {
  return 1 / (1 + 10 ** (-(dR + home) / 400));
}

/**
 * @param {object} p
 * @param {{t:number, home:string, away:string, x:number|null, y:number|null, group:string, country?:string|null, level?:number|null, neutral?:boolean}[]} p.matches
 *   t = day number; group = league id of the match ('E0', ... or 'CL'); country/level describe the CLUB's domestic league
 *   (omitted for 'CL').
 * @param {string[]} p.snapshotDates ISO dates (YYYY-MM-DD): a snapshot holds the ratings from matches strictly BEFORE the date
 * @param {number} [p.tNow] day number of "now": the `current` snapshot (all matches) is dated by it
 * @returns {{snapshots: Map<string, {club:string,country:string|null,level:number|null,elo:number,n:number}[]>,
 *            current: {club:string,country:string|null,level:number|null,elo:number,n:number}[], matches:number, clubs:number}}
 */
export function runOwnElo({ matches, snapshotDates = [], tNow = null }) {
  const list = matches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => Number.isInteger(m.x) && Number.isInteger(m.y) && m.home && m.away && m.home !== m.away)
    .sort((a, b) => a.m.t - b.m.t || a.i - b.i)
    .map(({ m }) => m);

  const clubs = new Map(); // key -> { elo, n, country, level, group, last }
  const leagueFirstDay = new Map(); // group -> day of the first match of the series
  const snaps = [...snapshotDates].sort().map((iso) => ({ iso, day: Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS }));
  const snapshots = new Map();
  let next = 0;

  const take = (day) =>
    [...clubs]
      .filter(([, c]) => day - c.last <= ELO.ACTIVE_DAYS)
      .map(([club, c]) => ({ club, country: c.country, level: c.level, elo: Math.round(c.elo * 10) / 10, n: c.n }));

  const meanOf = (pred, day) => {
    let s = 0;
    let k = 0;
    for (const c of clubs.values()) {
      if (day - c.last > ELO.ACTIVE_DAYS || !pred(c)) continue;
      s += c.elo;
      k++;
    }
    return k >= ELO.MIN_PEERS ? s / k : null;
  };

  const enter = (key, m) => {
    if (clubs.has(key)) return;
    const domestic = m.group !== 'CL';
    let start = ELO.START;
    if (domestic) {
      const open = m.t - (leagueFirstDay.get(m.group) ?? m.t) <= ELO.LEAGUE_OPEN_DAYS;
      const mean = open ? null : meanOf((c) => c.group === m.group, m.t);
      if (mean !== null) start = mean + ELO.NEWCOMER_OFFSET;
    } else {
      const mean = meanOf(() => true, m.t);
      if (mean !== null) start = mean + ELO.NEWCOMER_OFFSET;
    }
    clubs.set(key, { elo: start, n: 0, country: domestic ? m.country ?? null : null, level: domestic ? m.level ?? null : null, group: domestic ? m.group : null, last: m.t });
  };

  for (const m of list) {
    while (next < snaps.length && snaps[next].day <= m.t) {
      snapshots.set(snaps[next].iso, take(snaps[next].day));
      next++;
    }
    if (!leagueFirstDay.has(m.group)) leagueFirstDay.set(m.group, m.t);
    enter(m.home, m);
    enter(m.away, m);
    const h = clubs.get(m.home);
    const a = clubs.get(m.away);
    const we = expectedScore(h.elo - a.elo, m.neutral ? 0 : ELO.HOME);
    const w = m.x > m.y ? 1 : m.x === m.y ? 0.5 : 0;
    const delta = ELO.K * goalMultiplier(m.x - m.y) * (w - we);
    h.elo += delta;
    a.elo -= delta;
    h.n++;
    a.n++;
    h.last = a.last = m.t;
    // a club belongs to the latest domestic league it played in (promotion / relegation); cup matches do not change it
    if (m.group !== 'CL') {
      for (const c of [h, a]) {
        c.group = m.group;
        c.country = m.country ?? c.country;
        c.level = m.level ?? c.level;
      }
    }
  }
  const endDay = tNow ?? (list.length ? list[list.length - 1].t + 1 : 0);
  while (next < snaps.length) {
    snapshots.set(snaps[next].iso, take(Math.min(snaps[next].day, endDay)));
    next++;
  }
  return { snapshots, current: take(endDay), matches: list.length, clubs: clubs.size };
}

/**
 * Compare our ratings with ClubElo on the clubs both have: Pearson correlation and the mean absolute difference
 * after removing the average offset (the two scales may differ by a constant).
 * @param {Map<string, number>} ours key -> rating
 * @param {Map<string, number>} theirs key -> rating
 */
export function compareRatings(ours, theirs) {
  const pairs = [];
  for (const [k, v] of ours) if (theirs.has(k)) pairs.push([v, theirs.get(k)]);
  const n = pairs.length;
  if (n < 10) return { n, correlation: null, meanAbsDiff: null, offset: null };
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let abs = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
    abs += Math.abs(x - mx - (y - my));
  }
  const correlation = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  return { n, correlation, meanAbsDiff: abs / n, offset: mx - my };
}

export { isoOf };
