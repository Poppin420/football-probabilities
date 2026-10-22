// Live check of every data source. Run it from GitHub Actions
// ("Έλεγχος πηγών" workflow) or locally:  node scripts/check-sources.mjs
//
// For each source it makes a real request, validates the fields the code
// relies on and logs one sample. Secrets are read from the environment and
// are never printed. Exit code 1 only if a REQUIRED check fails.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRA_ELO_LEAGUES, LEAGUES, MODEL, OWN_ELO, RATE, csvSeasons, currentTime, eloPoolLeagues, isoDate, seasonStartYear } from '../src/config.js';
import { createFdOrgClient, sampleOf, parseFixtures } from '../src/sources/footballDataOrg.js';
import { createRapidEuropaClient } from '../src/sources/rapidEuropa.js';
import { fetchNewCsv, fetchSeasonCsv } from '../src/sources/footballDataCoUk.js';
import { fetchEloSnapshot } from '../src/sources/clubElo.js';
import { FALLBACK_MODEL, listModels, modelFromEnv } from '../src/sources/groq.js';
import { checkAccess, createApiFootballClient, normalizeUsage, parseApiFixtures } from '../src/sources/apiFootball.js';
import { createResolver } from '../src/sources/names.js';
import { loadAliases } from '../src/sources/aliases.js';
import { clubsByKey } from '../src/pipeline/championsLeague.js';
import { sleep } from '../src/sources/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = currentTime();
const only = process.env.FP_ONLY ? process.env.FP_ONLY.split(',').map((s) => s.trim()) : null;
const results = [];
const ICONS = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌', SKIP: '⏭️ ' };

function record(name, status, detail, required = false) {
  results.push({ name, status, detail, required });
  console.log(`${ICONS[status]} ${name}: ${detail}`);
}
const section = (title) => console.log(`\n--- ${title} ---`);
const short = (err) => String(err?.message ?? err).slice(0, 200);
const wantsCl = !only || only.includes('CL');
let clTeams = null; // Champions League clubs of football-data.org, compared with ClubElo further down

// 1. football-data.org ---------------------------------------------------------
section('football-data.org (fixtures, teams, scorers)');
const token = process.env.FOOTBALL_DATA_TOKEN;
if (!token) {
  record('football-data.org token', 'FAIL', 'FOOTBALL_DATA_TOKEN is not set (GitHub: Settings → Secrets and variables → Actions)', true);
} else {
  const client = createFdOrgClient({ token });
  try {
    const week = await client.fixtures('PL', { now, horizonDays: MODEL.horizonDays });
    record('fixtures PL (next 7 days)', 'PASS', `${week.fixtures.length} fixtures (requested ${week.requested.from} → ${week.requested.to})`, true);
    if (week.fixtures[0]) console.log(`   sample: ${sampleOf(week.fixtures[0])}`);
    else console.log('   (no fixtures in the next 7 days, e.g. an international break: the parser could not be sampled)');
    const rate = client.state.lastRate;
    if (rate && rate.available !== null) console.log(`   rate headers: ${rate.available} calls left this minute, counter resets in ${rate.reset}s`);
    else console.log('   rate headers: none returned (the client spaces calls >= 7 s apart anyway)');
  } catch (err) {
    record('fixtures PL (next 7 days)', 'FAIL', short(err), true);
  }

  // The maximum dateFrom/dateTo range is not documented: measure it.
  const pipelineDays = MODEL.horizonDays + 1; // the pipeline asks for today .. today+8
  const accepted = [];
  for (const days of [pipelineDays, 10, 11]) {
    try {
      const to = isoDate(new Date(now.getTime() + days * 86400000));
      const raw = await client.request('/competitions/PL/matches', { status: 'SCHEDULED,TIMED', dateFrom: isoDate(now), dateTo: to });
      parseFixtures(raw);
      accepted.push(days);
      record(`date range ${days} days`, 'PASS', `accepted (${raw.matches.length} matches)`);
    } catch (err) {
      record(`date range ${days} days`, 'WARN', `${short(err)}${days === pipelineDays ? ' (the pipeline then retries in 4-day chunks automatically)' : ''}`);
    }
  }
  console.log(accepted.length ? `   longest accepted range: ${Math.max(...accepted)} days (the pipeline needs ${pipelineDays})` : '   no range accepted');

  try {
    const { teams } = await client.teams('PL');
    record('teams PL', teams.length >= 18 ? 'PASS' : 'WARN', `${teams.length} teams`);
    if (teams[0]) console.log(`   sample: ${sampleOf(teams[0])}`);
  } catch (err) {
    record('teams PL', 'WARN', `${short(err)} (only needed by build-aliases)`);
  }

  const year = seasonStartYear(now);
  for (const [label, y] of [['current', year], ['previous', year - 1]]) {
    try {
      const res = await client.scorers('PL', y, 200);
      if (res.restricted) {
        record(`scorers PL ${y} (${label})`, 'WARN', label === 'current'
          ? `${res.reason}: scorers are not available on this plan, the "Σκόρερ" tab will stay empty`
          : `${res.reason}: last season's goals are not available on the free plan, so they are ignored`);
      } else {
        record(`scorers PL ${y} (${label})`, 'PASS', `${res.scorers.length} players (asked limit=200, API echoed ${res.echoedLimit ?? 'nothing'})`);
        if (res.scorers[0]) console.log(`   sample: ${sampleOf(res.scorers[0])}`);
      }
    } catch (err) {
      record(`scorers PL ${y} (${label})`, 'WARN', short(err));
    }
  }

  if (wantsCl) await checkChampionsLeague(client, year);
  if (!only || only.includes('EL')) await checkEuropaLeague(client, year);
  if (!only || only.includes('EL')) await checkExtraLeagues();
}

/** Europa League: optional. Its source is a RapidAPI listing (free plan: 500 calls a month): this check uses 2 calls. */
async function checkExtraLeagues() {
  section('Αποτελέσματα άλλων χωρών για το Elo (football-data.co.uk, χωρίς κλειδί)');
  for (const l of EXTRA_ELO_LEAGUES) {
    try {
      const res = await fetchNewCsv(l.file);
      if (res.missing) {
        record(`Elo ${l.file}`, 'WARN', 'το αρχείο δεν υπάρχει (404): η χώρα μένει εκτός Elo, τίποτα δεν χαλάει');
        continue;
      }
      const last = res.rows.at(-1);
      record(`Elo ${l.file}`, res.rows.length > 100 ? 'PASS' : 'WARN', `${res.rows.length} αγώνες με αποτέλεσμα (${res.total} γραμμές, ${res.skipped} δεν διαβάστηκαν)${last ? `, τελευταίος ${last.date} ${last.home} - ${last.away}` : ''}`);
    } catch (err) {
      record(`Elo ${l.file}`, 'WARN', `${short(err)} (η χώρα μένει εκτός Elo, τίποτα δεν χαλάει)`);
    }
  }
}

async function checkEuropaLeague(_client, year) {
  section('Europa League (RapidAPI, optional)');
  if (!process.env.RAPIDAPI_KEY) {
    record('Europa League key', 'SKIP', 'RAPIDAPI_KEY is not set: the Europa League stays off (steps in SETUP.md, section "Europa League")');
    return;
  }
  let rapid;
  try {
    rapid = createRapidEuropaClient({ key: process.env.RAPIDAPI_KEY });
  } catch (err) {
    record('Europa League key', 'WARN', short(err));
    return;
  }
  const quota = () => (rapid.state.remaining !== null ? `${rapid.state.remaining}${rapid.state.limit !== null ? ` of ${rapid.state.limit}` : ''} calls left` : 'calls left: not reported');
  try {
    const week = await rapid.fixtures('EL', { now, horizonDays: 14 });
    const next = week.fixtures[0];
    record('fixtures EL (next 14 days)', week.fixtures.length > 0 ? 'PASS' : 'WARN', week.fixtures.length > 0
      ? `${week.fixtures.length} fixtures, next ${next.kickoff} ${next.home.name} - ${next.away.name}${next.stage ? ` (${next.stage})` : ''} | ${quota()}`
      : `no fixtures in the next 14 days (normal between match weeks; if it stays so on a match week, the source does not have this season) | ${quota()}`);
    if (next) console.log(`   sample: ${sampleOf(next)}`);
  } catch (err) {
    record('fixtures EL (next 14 days)', 'WARN', `${short(err)} - the daily run then skips the Europa League (nothing breaks)`);
    return;
  }
  try {
    const res = await rapid.results('EL', year);
    if (res.restricted) {
      record(`results EL ${year}`, 'WARN', `${res.reason}: no finished matches of this season`);
    } else {
      const usable = res.results.filter((r) => r.x !== null).length;
      record(`results EL ${year}`, res.results.length > 0 ? 'PASS' : 'WARN', `${res.results.length} finished matches, 90-minute score used on ${usable} (knockout rounds are not used: the source gives one score only) | ${quota()}`);
      if (res.results[0]) console.log(`   sample: ${sampleOf(res.results[0])}`);
    }
  } catch (err) {
    record(`results EL ${year}`, 'WARN', short(err));
  }
}

/** Champions League (Phase 3): fixtures, finished matches of two seasons (the Elo-only model needs their 90-minute scores), clubs. */
async function checkChampionsLeague(client, year) {
  section('football-data.org: Champions League (Phase 3)');
  try {
    const week = await client.fixtures('CL', { now, horizonDays: MODEL.horizonDays });
    const stages = [...new Set(week.fixtures.map((f) => f.stage || 'no stage'))].join(', ') || 'none';
    record('fixtures CL (next 7 days)', 'PASS', `${week.fixtures.length} fixtures, stages: ${stages}${week.skipped ? `, ${week.skipped} skipped (teams not decided yet)` : ''}`);
    if (week.fixtures[0]) console.log(`   sample: ${sampleOf(week.fixtures[0])}`);
    else console.log('   (no Champions League matches in the next 7 days: normal outside match weeks)');
  } catch (err) {
    record('fixtures CL (next 7 days)', 'WARN', `${short(err)} (the Champions League tab will be empty)`);
  }
  for (const [label, y] of [['current', year], ['previous', year - 1]]) {
    try {
      const res = await client.results('CL', y);
      if (res.restricted) {
        record(`results CL ${y} (${label})`, 'WARN', label === 'current'
          ? `${res.reason}: the finished matches of this season are not available on this plan, the Champions League model then uses the league-wide average goals only`
          : `${res.reason}: last season's matches are not available on the free plan, so they are ignored`);
        continue;
      }
      const usable = res.results.filter((r) => r.x !== null).length;
      const extra = res.results.filter((r) => r.duration && r.duration !== 'REGULAR').length;
      const half = res.results.filter((r) => r.hthg !== null).length;
      record(`results CL ${y} (${label})`, 'PASS', `${res.results.length} finished matches | 90-minute score on ${usable} | extra time / penalties ${extra} (${res.results.length - usable} without a 90-minute score are not used) | half-time score on ${half}`);
      if (res.results[0]) console.log(`   sample: ${sampleOf(res.results[0])}`);
      const knockout = res.results.find((r) => r.duration && r.duration !== 'REGULAR');
      if (knockout) console.log(`   sample (extra time / penalties): ${sampleOf(knockout)}`);
    } catch (err) {
      record(`results CL ${y} (${label})`, 'WARN', short(err));
    }
  }
  // older seasons: the history of our own Elo (5 completed seasons); a restricted or missing season only means less history
  const older = [];
  for (let y = year - 2; y >= year - OWN_ELO.completedSeasons; y--) {
    try {
      const res = await client.results('CL', y);
      older.push(res.restricted ? `${y}: ${res.reason}` : `${y}: ${res.results.filter((r) => r.x !== null).length} matches`);
    } catch (err) {
      older.push(`${y}: ${short(err)}`);
    }
  }
  const usableOlder = older.filter((t) => /matches/.test(t) && !/: 0 matches/.test(t)).length;
  record('results CL older seasons (own Elo history)', usableOlder === older.length ? 'PASS' : 'WARN', `${older.join(' | ')}${usableOlder < older.length ? ' - the seasons outside the free plan are simply not used (the Elo then starts from fewer Champions League matches)' : ''}`);
  try {
    clTeams = (await client.teams('CL')).teams;
    record('teams CL', clTeams.length >= 16 ? 'PASS' : 'WARN', `${clTeams.length} clubs`);
  } catch (err) {
    record('teams CL', 'WARN', `${short(err)} (only needed to compare the club names with ClubElo)`);
  }
}

// 2. football-data.co.uk ---------------------------------------------------------
section('football-data.co.uk (CSV history)');
const seasons = csvSeasons(now);
const current = seasons.at(-1);
const prevCompleted = seasons.filter((s) => !s.current).at(-1);
const csvLeagues = LEAGUES.filter((l) => l.div && (l.enabled || l.reason) && (!only || only.includes(l.code)));
for (const league of csvLeagues) {
  const required = league.enabled;
  const tag = league.enabled ? '' : ' [disabled league]';
  try {
    const res = await fetchSeasonCsv(league.div, prevCompleted.code);
    if (res.missing) {
      record(`${league.div} ${prevCompleted.code}`, required ? 'FAIL' : 'WARN', `file not found (HTTP 404)${tag}`, required);
    } else {
      const s = res.stats;
      const pct = (n) => (s.valid ? `${Math.round((100 * n) / s.valid)}%` : 'n/a');
      const detail = `${s.valid} matches | corners ${pct(s.withCorners)} | yellows ${pct(s.withYellows)} | shots ${pct(s.withShots)} | half-time ${pct(s.withHalfTime)} | referee ${pct(s.withReferee)}`;
      const goalsOnly = s.withCorners === 0 && s.withYellows === 0;
      const noHalf = s.valid > 0 && s.withHalfTime < 0.5 * s.valid;
      const status = s.valid < 100 ? 'FAIL' : goalsOnly || noHalf ? 'WARN' : 'PASS';
      record(`${league.div} ${prevCompleted.code}`, status, `${detail}${goalsOnly ? ' → goals-only league' : ''}${noHalf ? ' → too few half-time scores: the half-time / full-time markets of this league are switched off' : ''}${tag}`, required && status === 'FAIL');
      if (league.div === 'E0' && res.rows[0]) console.log(`   columns found: ${s.columns.join(',')}\n   sample: ${sampleOf(res.rows[0])}`);
    }
  } catch (err) {
    record(`${league.div} ${prevCompleted.code}`, required ? 'FAIL' : 'WARN', `${short(err)}${tag}`, required);
  }
  await sleep(RATE.csvPauseMs);
}
for (const league of csvLeagues.filter((l) => l.enabled)) {
  try {
    const cur = await fetchSeasonCsv(league.div, current.code);
    if (cur.missing) {
      record(`${league.div} ${current.code} (current)`, 'WARN', 'not published yet (normal in July / early August)');
    } else {
      const latest = cur.rows.reduce((m, r) => (r.date > m ? r.date : m), '');
      record(`${league.div} ${current.code} (current)`, 'PASS', `${cur.stats.valid} matches played, latest ${latest || 'n/a'}`);
    }
  } catch (err) {
    record(`${league.div} ${current.code} (current)`, 'FAIL', short(err), true);
  }
  await sleep(RATE.csvPauseMs);
}

// 3. ClubElo -----------------------------------------------------------------------
section('Own Elo (computed from the results) and ClubElo (optional cross-check)');
{
  // depth of the history: the oldest of the 5 completed seasons must exist for the leagues that feed our own Elo
  const oldest = csvSeasons(now, OWN_ELO.completedSeasons)[0];
  let have = 0;
  const lacking = [];
  const pool = eloPoolLeagues().filter((l) => !only || only.includes(l.code));
  for (const league of pool) {
    try {
      const res = await fetchSeasonCsv(league.div, oldest.code);
      if (res.missing || res.stats.valid < 100) lacking.push(league.div);
      else have++;
    } catch (err) {
      lacking.push(`${league.div} (${short(err)})`);
    }
    await sleep(RATE.csvPauseMs);
  }
  if (pool.length > 0) {
    record(`own Elo history ${oldest.code}`, lacking.length === 0 ? 'PASS' : 'WARN', lacking.length === 0
      ? `${have} leagues have the oldest season (${oldest.code}) of the history`
      : `${lacking.length} of ${pool.length} leagues lack the season ${oldest.code}: ${lacking.join(', ')} (they just start later in the series; the rating of their clubs is then less settled)`);
  }
}
try {
  const snap = await fetchEloSnapshot(isoDate(now));
  const byCountry = new Map();
  for (const c of snap.clubs) byCountry.set(c.country, (byCountry.get(c.country) || 0) + 1);
  record('ClubElo snapshot', 'PASS', `${snap.clubs.length} clubs on ${snap.date}`);
  console.log(`   sample: ${sampleOf(snap.clubs[0])}`);
  for (const l of csvLeagues.filter((x) => x.enabled && x.code !== 'ELC')) {
    const n = byCountry.get(l.eloCountry) || 0;
    if (n < 16) record(`Elo country ${l.eloCountry} (${l.name})`, 'WARN', `only ${n} clubs listed: check the country code in src/config.js`);
  }
  if (wantsCl && clTeams) checkClubNames(snap);
} catch (err) {
  record('ClubElo snapshot', 'WARN', `${short(err)} (not needed: the models use our own Elo; ClubElo is only an optional cross-check)`);
}

/** The Champions League clubs of football-data.org against the ClubElo list, the way the pipeline matches them. */
function checkClubNames(snap) {
  const { aliases, warnings } = loadAliases(process.env.ALIASES_PATH || path.join(root, 'aliases.json'));
  for (const w of warnings) console.log(`   ⚠️  ${w.message}`);
  const resolver = createResolver(aliases);
  const universe = new Set(clubsByKey(snap.clubs, resolver).keys());
  const bad = clTeams.filter((t) => !resolver.matchAny([t.name, t.shortName], universe).key);
  if (bad.length === 0) {
    record('Champions League clubs vs ClubElo', 'PASS', `all ${clTeams.length} clubs matched`);
  } else {
    record('Champions League clubs vs ClubElo', 'WARN', `${bad.length} of ${clTeams.length} not matched (${bad.map((t) => `"${t.name}"`).join(', ')}): their matches are skipped until an alias is added - see the step "Ονόματα ομάδων" below for ready-to-paste lines`);
  }
}

// 4. Groq --------------------------------------------------------------------------
section('Groq (Greek match comment, Phase 2)');
if (!process.env.GROQ_API_KEY) {
  record('Groq key', 'SKIP', 'GROQ_API_KEY is not set (optional: without it the Greek comment is the automatic template text)');
} else {
  try {
    const g = await listModels({ key: process.env.GROQ_API_KEY });
    const wanted = modelFromEnv();
    const has = (m) => g.models.includes(m);
    if (!g.ok) {
      record('Groq key', 'WARN', g.reason);
    } else {
      const detail = `key accepted; ${g.models.length} models active; first choice "${wanted}" ${has(wanted) ? 'is available' : 'is NOT available'}; fallback "${FALLBACK_MODEL}" ${has(FALLBACK_MODEL) ? 'is available' : 'is NOT available'}`;
      if (has(wanted) && has(FALLBACK_MODEL)) {
        record('Groq key', 'PASS', detail);
      } else {
        const chat = g.models.filter((m) => !/whisper|orpheus|guard|tts|embed|safeguard/i.test(m)).slice(0, 15);
        record('Groq key', 'WARN', `${detail}. Set the repository variable GROQ_MODEL to one of: ${chat.join(', ')}`);
      }
    }
  } catch (err) {
    record('Groq key', 'WARN', short(err));
  }
}

// 5. API-Football ----------------------------------------------------------------------
section('API-Football (optional extras: referee and absences, Phase 3)');
if (!process.env.API_FOOTBALL_KEY) {
  record('API-Football', 'SKIP', 'API_FOOTBALL_KEY is not set (optional)');
} else {
  await checkApiFootball(process.env.API_FOOTBALL_KEY);
}

/** At most 4 requests: the access test (Premier League fixtures), the Champions League fixtures, one injuries call. */
async function checkApiFootball(key) {
  const season = seasonStartYear(now);
  let access;
  try {
    access = await checkAccess({ key, season, now });
  } catch (err) {
    record('API-Football current season', 'WARN', `extras DISABLED: ${short(err)}`);
    return;
  }
  record('API-Football current season', access.ok ? 'PASS' : 'WARN', access.ok
    ? `${access.reason}; requests left today: ${access.remaining ?? 'unknown'} (budget used by the project: at most 40/day)`
    : `extras DISABLED: ${access.reason}`);
  if (!access.ok) return;

  const fixtureLists = [];
  const note = (name, parsed) => {
    const withReferee = parsed.fixtures.filter((f) => f.referee).length;
    record(`API-Football fixtures ${name}`, 'PASS', `${parsed.fixtures.length} fixtures in the next 7 days, referee named on ${withReferee} (the referee is usually announced 1-2 days before the match)`);
    if (parsed.fixtures[0]) console.log(`   sample: ${sampleOf(parsed.fixtures[0])}`);
    fixtureLists.push(...parsed.fixtures);
  };
  try {
    note('PL', parseApiFixtures(access.body));
  } catch (err) {
    record('API-Football fixtures PL', 'WARN', `${short(err)} (the code cannot read this answer: referees / absences stay off)`);
    return;
  }
  const usage = normalizeUsage(null, now);
  const client = createApiFootballClient({ key, usage, now, logger: { warn() {} } });
  if (wantsCl) {
    try {
      const to = isoDate(new Date(now.getTime() + MODEL.horizonDays * 86400000));
      note('CL', await client.fixtures({ league: 2, season, from: isoDate(now), to }));
    } catch (err) {
      record('API-Football fixtures CL', 'WARN', short(err));
    }
  }
  const soon = fixtureLists.filter((f) => Date.parse(f.kickoff) - now.getTime() < 72 * 3600000).slice(0, 20);
  if (soon.length === 0) {
    console.log('   (no fixture within 72 hours: the injuries endpoint could not be sampled)');
  } else {
    try {
      const inj = await client.injuries({ ids: soon.map((f) => f.id) });
      const out = inj.records.filter((r) => r.state === 'out').length;
      const kinds = [...new Set(inj.records.map((r) => `${r.kind}`))].join(', ') || 'none';
      record('API-Football injuries', 'PASS', `${inj.records.length} records for ${soon.length} fixtures (${out} will miss the match, ${inj.records.length - out} doubtful; reasons: ${kinds}; ${inj.ignored} ignored)`);
      if (inj.records[0]) console.log(`   sample: ${sampleOf(inj.records[0])}`);
    } catch (err) {
      record('API-Football injuries', 'WARN', short(err));
    }
  }
  console.log(`   requests used by this check: ${client.usage.calls + 1}; left today: ${client.state.remaining ?? access.remaining ?? 'unknown'}`);
}

// Summary ----------------------------------------------------------------------------------
console.log('\n=========== RESULT ===========');
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`${count('PASS')} passed, ${count('WARN')} warnings, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
for (const r of results.filter((x) => x.status === 'FAIL' || x.status === 'WARN')) console.log(`${r.status}  ${r.name}: ${r.detail}`);
const failed = results.filter((r) => r.required && r.status === 'FAIL');
console.log(failed.length ? `\n${failed.length} REQUIRED check(s) failed.` : '\nAll required checks passed.');
process.exit(failed.length ? 1 : 0);
