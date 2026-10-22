// Central configuration: leagues, base URLs, model defaults, season helpers.
// Base URLs can be overridden by environment variables (used by the tests,
// which run the whole pipeline against local mock servers).

const env = process.env;

export const BASES = {
  fdOrg: env.FD_ORG_BASE || 'https://api.football-data.org/v4',
  csv: env.FD_CSV_BASE || 'https://www.football-data.co.uk/mmz4281',
  elo: env.ELO_BASE || 'http://api.clubelo.com',
  groq: env.GROQ_BASE || 'https://api.groq.com/openai/v1',
  apiFootball: env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io',
  csvNew: env.FD_CSV_NEW_BASE || (env.FD_CSV_BASE ? env.FD_CSV_BASE.replace(/\/mmz4281$/, '/new') : 'https://www.football-data.co.uk/new'),
  rapidEuropa: env.RAPID_EL_BASE || 'https://uefa-europa-league.p.rapidapi.com',
};

/**
 * Leagues. code = football-data.org competition code, div = football-data.co.uk
 * division. phase = the build phase in which the league goes live.
 * enabled:false entries have CSV history but no free fixture source.
 */
export const LEAGUES = [
  { code: 'PL', div: 'E0', name: 'Premier League', country: 'Αγγλία', eloCountry: 'ENG', eloLevel: 1, afId: 39, phase: 1, enabled: true },
  { code: 'ELC', div: 'E1', name: 'Championship', country: 'Αγγλία', eloCountry: 'ENG', eloLevel: 2, afId: 40, phase: 1, enabled: true },
  { code: 'BL1', div: 'D1', name: 'Bundesliga', country: 'Γερμανία', eloCountry: 'GER', eloLevel: 1, afId: 78, phase: 1, enabled: true },
  { code: 'SA', div: 'I1', name: 'Serie A', country: 'Ιταλία', eloCountry: 'ITA', eloLevel: 1, afId: 135, phase: 1, enabled: true },
  { code: 'PD', div: 'SP1', name: 'La Liga', country: 'Ισπανία', eloCountry: 'ESP', eloLevel: 1, afId: 140, phase: 1, enabled: true },
  { code: 'FL1', div: 'F1', name: 'Ligue 1', country: 'Γαλλία', eloCountry: 'FRA', eloLevel: 1, afId: 61, phase: 1, enabled: true },
  { code: 'DED', div: 'N1', name: 'Eredivisie', country: 'Ολλανδία', eloCountry: 'NED', eloLevel: 1, afId: 88, phase: 1, enabled: true },
  { code: 'PPL', div: 'P1', name: 'Primeira Liga', country: 'Πορτογαλία', eloCountry: 'POR', eloLevel: 1, afId: 94, phase: 1, enabled: true },
  // Phase 3: Elo-only model (ClubElo difference only), no domestic history of its own.
  { code: 'CL', div: null, name: 'Champions League', country: 'Ευρώπη', afId: 2, eloOnly: true, phase: 3, enabled: true },
  // Europa League: same Elo-only model. Its data come from the RapidAPI listing (football-data.org's free plan does not have it).
  // Optional: without RAPIDAPI_KEY (or when the source fails) it is skipped with a note.
  { code: 'EL', div: null, name: 'Europa League', country: 'Ευρώπη', eloOnly: true, optional: true, source: 'rapid', phase: 3, enabled: true },
  // Goals-only CSV leagues; football-data.org's free tier has no fixtures for them.
  { code: 'B1', div: 'B1', name: 'Jupiler League', country: 'Βέλγιο', eloCountry: 'BEL', eloLevel: 1, phase: 9, enabled: false, reason: 'no free fixture source' },
  { code: 'T1', div: 'T1', name: 'Süper Lig', country: 'Τουρκία', eloCountry: 'TUR', eloLevel: 1, phase: 9, enabled: false, reason: 'no free fixture source' },
  { code: 'G1', div: 'G1', name: 'Super League', country: 'Ελλάδα', eloCountry: 'GRE', eloLevel: 1, phase: 9, enabled: false, reason: 'no free fixture source' },
  { code: 'SC0', div: 'SC0', name: 'Premiership', country: 'Σκωτία', eloCountry: 'SCO', eloLevel: 1, phase: 9, enabled: false, reason: 'no free fixture source' },
  // Second (and third) tiers: only the results are read, to rate the clubs that move between divisions.
  // They feed our own Elo only when ELO_TIERS=on (see eloPoolLeagues); the lab job (scripts/lab-elo.mjs) tests whether that helps.
  { code: 'E2', div: 'E2', name: 'League One', country: 'Αγγλία', eloCountry: 'ENG', eloLevel: 3, phase: 9, enabled: false, tier: 2, reason: 'results only (rates promoted clubs)' },
  { code: 'D2', div: 'D2', name: '2. Bundesliga', country: 'Γερμανία', eloCountry: 'GER', eloLevel: 2, phase: 9, enabled: false, tier: 2, reason: 'results only (rates promoted clubs)' },
  { code: 'I2', div: 'I2', name: 'Serie B', country: 'Ιταλία', eloCountry: 'ITA', eloLevel: 2, phase: 9, enabled: false, tier: 2, reason: 'results only (rates promoted clubs)' },
  { code: 'SP2', div: 'SP2', name: 'La Liga 2', country: 'Ισπανία', eloCountry: 'ESP', eloLevel: 2, phase: 9, enabled: false, tier: 2, reason: 'results only (rates promoted clubs)' },
  { code: 'F2', div: 'F2', name: 'Ligue 2', country: 'Γαλλία', eloCountry: 'FRA', eloLevel: 2, phase: 9, enabled: false, tier: 2, reason: 'results only (rates promoted clubs)' },
];

/**
 * Further countries whose clubs play in the Europa League. Only their RESULTS are read (football-data.co.uk "new leagues"
 * files, one CSV per country with every season) to rate their clubs in our own Elo. They have no page of their own.
 */
export const EXTRA_ELO_LEAGUES = Object.freeze([
  { code: 'AUT', div: 'AUT', file: 'AUT', name: 'Bundesliga (Αυστρία)', country: 'Αυστρία', eloCountry: 'AUT', eloLevel: 1 },
  { code: 'DNK', div: 'DNK', file: 'DNK', name: 'Superliga (Δανία)', country: 'Δανία', eloCountry: 'DEN', eloLevel: 1 },
  { code: 'SWZ', div: 'SWZ', file: 'SWZ', name: 'Super League (Ελβετία)', country: 'Ελβετία', eloCountry: 'SUI', eloLevel: 1 },
  { code: 'NOR', div: 'NOR', file: 'NOR', name: 'Eliteserien (Νορβηγία)', country: 'Νορβηγία', eloCountry: 'NOR', eloLevel: 1 },
  { code: 'POL', div: 'POL', file: 'POL', name: 'Ekstraklasa (Πολωνία)', country: 'Πολωνία', eloCountry: 'POL', eloLevel: 1 },
]);

export const CURRENT_PHASE = 3;

export function activeLeagues(only = null) {
  return LEAGUES.filter((l) => l.enabled && l.phase <= CURRENT_PHASE && (!only || only.includes(l.code)));
}

/** The leagues with their own history (football-data.co.uk CSV): everything except the Elo-only cup. */
export function domesticLeagues(only = null) {
  return activeLeagues(only).filter((l) => !l.eloOnly);
}

/** The Elo-only competitions (Champions League). */
export function cupLeagues(only = null) {
  return activeLeagues(only).filter((l) => l.eloOnly);
}

/**
 * The leagues whose CSV results feed our own Elo (the enabled ones plus the goals-only ones): every league with a
 * `div` and an `eloCountry`. Only the enabled leagues are modelled; the others just give the Elo of their clubs
 * (they play the Champions League) a history.
 */
export function eloPoolLeagues({ withTiers = env.ELO_TIERS === 'on' } = {}) {
  return LEAGUES.filter((l) => l.div && l.eloCountry && (withTiers || !l.tier));
}

/** Own Elo (src/model/ownElo.js): how much history is read. */
export const OWN_ELO = Object.freeze({
  completedSeasons: 5, // 5 completed seasons + the current one
});

export const MODEL = Object.freeze({
  xi: 0.0019,
  sigma: 0.25,
  sigmaCounts: 0.2,
  horizonDays: 7, // fixtures shown: the next 7 days
  csvCompletedSeasons: 3, // last 3 completed seasons + the current one
  fewDataWeighted: 15, // badge "λίγα δεδομένα" below this weighted match count
  lowConfidenceWeighted: 5, // badge "χαμηλή βεβαιότητα" below this
  scorersPerTeam: 8,
  scorersCacheHours: 24,
  eloCacheHours: 20,
  extrasHorizonHours: 72, // API-Football injuries are only requested for matches kicking off within this many hours
  extrasCacheHours: 30, // referees / injuries from the previous run are reused when the API budget is spent
  staleAfterHours: 30, // UI shows "παλιά δεδομένα" when the data are older than this
});

export const RATE = Object.freeze({
  // football-data.org free tier: 10 calls/min -> at least 7 s between calls.
  fdOrgMinIntervalMs: Number(env.FD_ORG_MIN_INTERVAL_MS ?? 7000),
  csvPauseMs: Number(env.CSV_PAUSE_MS ?? 1000),
  // API-Football free plan: 10 requests/minute -> one request every 6.5 s.
  apiFootballMinIntervalMs: Number(env.API_FOOTBALL_MIN_INTERVAL_MS ?? 6500),
  // ... and after a "too many requests" answer the client waits for the minute to pass once.
  apiFootballRateWaitMs: Number(env.API_FOOTBALL_RATE_WAIT_MS ?? 62000),
});

const DAY_MS = 86400000;

/** Day number (days since 1970-01-01 UTC) of a Date. */
export function dayNumber(date) {
  return Math.floor(date.getTime() / DAY_MS);
}

export function dayNumberFromIso(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Season start year: seasons start in July/August (Oct 2026 -> 2026). */
export function seasonStartYear(date) {
  const y = date.getUTCFullYear();
  return date.getUTCMonth() >= 6 ? y : y - 1;
}

/** football-data.co.uk season folder code, e.g. 2026 -> "2627". */
export function seasonCode(startYear) {
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return a + b;
}

/** Last N completed seasons plus the current one, oldest first. */
export function csvSeasons(now, completed = MODEL.csvCompletedSeasons) {
  const cur = seasonStartYear(now);
  const out = [];
  for (let y = cur - completed; y <= cur; y++) {
    out.push({ startYear: y, code: seasonCode(y), current: y === cur });
  }
  return out;
}

/** "Now" can be pinned for reproducible runs and tests. */
export function currentTime() {
  return env.FP_NOW ? new Date(env.FP_NOW) : new Date();
}
