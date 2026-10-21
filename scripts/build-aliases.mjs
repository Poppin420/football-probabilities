// Prints every team name that cannot be matched across the sources, with the
// closest candidates and a ready-to-paste line for aliases.json.
//   node scripts/build-aliases.mjs
// Needs FOOTBALL_DATA_TOKEN for the football-data.org team lists (without it
// only the CSV <-> ClubElo comparison runs). Nothing is written to disk.
//
// Two checks per league, mirroring what the pipeline does:
//   1. football-data.org teams vs (CSV teams + ClubElo clubs of the same country).
//      An unmatched name here means that club's fixtures are SKIPPED.
//   2. CSV teams vs ClubElo. An unmatched name here only loses the Elo number.
// The Champions League (Phase 3) has no CSV: its clubs are compared with the ClubElo clubs of the top two
// divisions of every country (check 1 only).
// Exit code 1 when check 1 finds an unmatched name.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATE, activeLeagues, csvSeasons, currentTime, isoDate } from '../src/config.js';
import { createFdOrgClient } from '../src/sources/footballDataOrg.js';
import { fetchSeasonCsv } from '../src/sources/footballDataCoUk.js';
import { fetchEloSnapshot } from '../src/sources/clubElo.js';
import { createResolver, similarity } from '../src/sources/names.js';
import { loadAliases } from '../src/sources/aliases.js';
import { TOP_LEVELS } from '../src/pipeline/championsLeague.js';
import { sleep } from '../src/sources/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aliasesPath = process.env.ALIASES_PATH || path.join(root, 'aliases.json');
// ALIASES_BUILTIN=off: only the file above (used by the tests to see what an unknown name looks like)
const loadedAliases = loadAliases(aliasesPath, process.env.ALIASES_BUILTIN === 'off' ? { builtinPath: null } : {});
for (const w of loadedAliases.warnings) console.log(`⚠️  ${w.message}`);
const resolver = createResolver(loadedAliases.aliases);
const now = currentTime();
const only = process.env.FP_ONLY ? process.env.FP_ONLY.split(',').map((s) => s.trim()) : null;
const seasons = csvSeasons(now).slice(-2); // previous completed + current

const elo = await fetchEloSnapshot(isoDate(now)).catch((err) => {
  console.log(`ClubElo unavailable: ${String(err.message).slice(0, 160)}\n`);
  return null;
});
const client = process.env.FOOTBALL_DATA_TOKEN ? createFdOrgClient({ token: process.env.FOOTBALL_DATA_TOKEN }) : null;
if (!client) console.log('FOOTBALL_DATA_TOKEN is not set: football-data.org names are not checked.\n');
if (resolver.conflicts.length > 0) {
  console.log('⚠️  the alias files have conflicting entries (the same alias in two groups):');
  for (const c of resolver.conflicts) console.log(`   "${c.alias}" is in groups ${c.groups.join(' and ')}`);
  console.log('');
}

let unmatchedFixtures = 0;
let unmatchedElo = 0;
const suggestions = new Map(); // line -> true (deduplicated, insertion ordered)

/** key -> display name, keeping the first spelling seen. */
function displayMap(names) {
  const map = new Map();
  for (const n of names) {
    const k = resolver.key(n);
    if (k && !map.has(k)) map.set(k, n);
  }
  return map;
}

/**
 * Score used ONLY to rank alias suggestions (the automatic matcher is stricter):
 * string similarity, or the share of words one name contains of the other
 * ("forest" inside "nottm forest").
 */
function hint(a, b) {
  const A = a.split(' ').filter(Boolean);
  const B = b.split(' ').filter(Boolean);
  const shared = A.filter((t) => B.includes(t)).length;
  const containment = shared > 0 ? shared / Math.min(A.length, B.length) : 0;
  return Math.max(similarity(a, b), 0.85 * containment);
}
const SUGGEST_MIN = 0.6;

/**
 * items: [{ name, shortName? }]; universe: Map(key -> display name).
 * Returns the number of unmatched items.
 * Suggestions only consider clubs of the other list that no other name has
 * claimed: one club can correspond to one club only, so "Burnley" is never
 * offered "Bournemouth" when "Bournemouth" is already matched.
 */
function check(title, items, universe) {
  const keys = new Set(universe.keys());
  const bad = [];
  const fuzzy = [];
  const claimed = new Set();
  for (const item of items) {
    const m = resolver.matchAny([item.name, item.shortName], keys);
    if (!m.key) bad.push({ item, m });
    else {
      claimed.add(m.key);
      if (m.how === 'fuzzy') fuzzy.push({ item, m });
    }
  }
  if (bad.length === 0) {
    console.log(`  ✅ ${title}: all ${items.length} names matched`);
  } else {
    console.log(`  ❌ ${title}: ${bad.length} of ${items.length} NOT matched`);
    const free = [...keys].filter((k) => !claimed.has(k));
    for (const { item, m } of bad) {
      const k = resolver.key(item.name);
      const near = free
        .map((u) => ({ key: u, score: hint(k, u) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      const nearText = near.length > 0 ? near.map((b) => `${universe.get(b.key)} (${b.score.toFixed(2)})`).join(', ') : 'none';
      console.log(`     - "${item.name}"${item.shortName && item.shortName !== item.name ? ` (short: "${item.shortName}")` : ''} [${m.how}]  closest unmatched in the other list: ${nearText}`);
      if (near[0] && near[0].score >= SUGGEST_MIN) {
        suggestions.set(`  ${JSON.stringify(universe.get(near[0].key))}: [${JSON.stringify(item.name)}],`, true);
      }
    }
  }
  // Fuzzy matches are accepted automatically: list them so a wrong one can be spotted.
  for (const { item, m } of fuzzy) {
    console.log(`     ~ "${item.name}" was matched by similarity (${m.score.toFixed(2)}) to "${universe.get(m.key)}": check that this is the same club`);
  }
  return bad.length;
}

for (const league of activeLeagues(only)) {
  console.log(`\n[${league.code}] ${league.name}`);
  if (league.eloOnly) {
    // Champions League: no CSV history, the clubs come from any country (top two divisions, like the pipeline)
    if (!client) continue;
    const universe = displayMap(elo ? elo.clubs.filter((c) => !Number.isFinite(c.level) || c.level <= TOP_LEVELS).map((c) => c.club) : []);
    if (!elo) {
      console.log('  ClubElo is not available: the Champions League names cannot be compared.');
      continue;
    }
    try {
      const { teams } = await client.teams(league.code);
      unmatchedFixtures += check('football-data.org vs ClubElo (decides if matches are used)', teams, universe);
    } catch (err) {
      console.log(`  football-data.org teams: ${String(err.message).slice(0, 160)}`);
    }
    continue;
  }
  const csvNames = [];
  for (const s of seasons) {
    try {
      const res = await fetchSeasonCsv(league.div, s.code);
      for (const r of res.rows) csvNames.push(r.home, r.away);
    } catch (err) {
      console.log(`  CSV ${league.div} ${s.code}: ${String(err.message).slice(0, 160)}`);
    }
    await sleep(RATE.csvPauseMs);
  }
  const csvMap = displayMap(csvNames);
  const eloMap = displayMap(elo ? elo.clubs.filter((c) => !league.eloCountry || c.country === league.eloCountry).map((c) => c.club) : []);
  // The pipeline matches fixtures against CSV teams and same-country Elo clubs together.
  const union = new Map([...eloMap, ...csvMap]);

  if (client) {
    try {
      const { teams } = await client.teams(league.code);
      unmatchedFixtures += check('football-data.org vs CSV + ClubElo (decides if fixtures are used)', teams, union);
    } catch (err) {
      console.log(`  football-data.org teams: ${String(err.message).slice(0, 160)}`);
    }
  }
  if (elo) {
    unmatchedElo += check('CSV teams vs ClubElo (only the Elo number depends on it)', [...csvMap.values()].map((name) => ({ name })), eloMap);
  }
}

console.log('\n================ RESULT ================');
if (unmatchedFixtures + unmatchedElo === 0) {
  console.log('Every name matched. aliases.json needs no changes.');
} else {
  if (unmatchedFixtures > 0) console.log(`${unmatchedFixtures} football-data.org name(s) cannot be matched: their fixtures are SKIPPED until an alias is added.`);
  if (unmatchedElo > 0) console.log(`${unmatchedElo} CSV name(s) are missing in ClubElo (old clubs that left the league are normal and harmless).`);
  if (suggestions.size > 0) {
    console.log('\nSuggested lines for aliases.json (inside the outer { }, check each one before pasting!):\n');
    for (const line of suggestions.keys()) console.log(line);
  }
}
process.exit(unmatchedFixtures > 0 ? 1 : 0);
