import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalKey, createResolver, jaroWinkler, tokenJaccard } from '../src/sources/names.js';
import { loadAliases } from '../src/sources/aliases.js';

// the built-in list plus the (initially empty) own list of the user, exactly what the pipeline uses
const loaded = loadAliases(new URL('../aliases.json', import.meta.url).pathname);
const aliases = loaded.aliases;
const resolver = createResolver(aliases);

// Known tricky pairs [football-data.org spelling, football-data.co.uk spelling].
// The CSV spellings for the Premier League were checked against a real
// 2025/26 E0.csv; the rest are the usual spellings in that data set.
const FD_ORG_VS_CSV = [
  ['Manchester City FC', 'Man City'],
  ['Manchester United FC', 'Man United'],
  ['Newcastle United FC', 'Newcastle'],
  ['Tottenham Hotspur FC', 'Tottenham'],
  ['Nottingham Forest FC', "Nott'm Forest"],
  ['Wolverhampton Wanderers FC', 'Wolves'],
  ['Brighton & Hove Albion FC', 'Brighton'],
  ['West Ham United FC', 'West Ham'],
  ['Leeds United FC', 'Leeds'],
  ['AFC Bournemouth', 'Bournemouth'],
  ['Sheffield Wednesday FC', 'Sheffield Weds'],
  ['Queens Park Rangers FC', 'QPR'],
  ['West Bromwich Albion FC', 'West Brom'],
  ['FC Bayern München', 'Bayern Munich'],
  ['Borussia Dortmund', 'Dortmund'],
  ['Bayer 04 Leverkusen', 'Leverkusen'],
  ['Borussia Mönchengladbach', "M'gladbach"],
  ['Eintracht Frankfurt', 'Ein Frankfurt'],
  ['1. FSV Mainz 05', 'Mainz'],
  ['TSG 1899 Hoffenheim', 'Hoffenheim'],
  ['1. FC Heidenheim 1846', 'Heidenheim'],
  ['VfL Bochum 1848', 'Bochum'],
  ['FC St. Pauli 1910', 'St Pauli'],
  ['1. FC Köln', 'FC Koln'],
  ['FC Internazionale Milano', 'Inter'],
  ['AC Milan', 'Milan'],
  ['Atalanta BC', 'Atalanta'],
  ['ACF Fiorentina', 'Fiorentina'],
  ['Hellas Verona FC', 'Verona'],
  ['Bologna FC 1909', 'Bologna'],
  ['Club Atlético de Madrid', 'Ath Madrid'],
  ['Athletic Club', 'Ath Bilbao'],
  ['Real Sociedad de Fútbol', 'Sociedad'],
  ['Real Betis Balompié', 'Betis'],
  ['RC Celta de Vigo', 'Celta'],
  ['RCD Espanyol de Barcelona', 'Espanol'],
  ['Rayo Vallecano de Madrid', 'Vallecano'],
  ['Deportivo Alavés', 'Alaves'],
  ['Paris Saint-Germain FC', 'Paris SG'],
  ['Olympique de Marseille', 'Marseille'],
  ['Olympique Lyonnais', 'Lyon'],
  ['Stade Rennais FC 1901', 'Rennes'],
  ['Stade Brestois 29', 'Brest'],
  ['AS Saint-Étienne', 'St Etienne'],
  ['RC Strasbourg Alsace', 'Strasbourg'],
  ['Racing Club de Lens', 'Lens'],
  ['PSV', 'PSV Eindhoven'],
  ['Feyenoord Rotterdam', 'Feyenoord'],
  ["FC Twente '65", 'Twente'],
  ['Fortuna Sittard', 'For Sittard'],
  ['NEC', 'NEC Nijmegen'],
  ['Sporting Clube de Portugal', 'Sp Lisbon'],
  ['Sporting Clube de Braga', 'Sp Braga'],
  ['SL Benfica', 'Benfica'],
  ['Vitória SC', 'Guimaraes'],
  ['CF Estrela da Amadora', 'Estrela'],
  ['GD Estoril Praia', 'Estoril'],
];

// Spellings used by ClubElo as recalled; build-aliases.mjs prints the real
// unmatched names against the live data.
const CSV_VS_ELO = [
  ['Man City', 'Man City'],
  ['Man United', 'Man United'],
  ["Nott'm Forest", 'Forest'],
  ['Tottenham', 'Tottenham'],
  ['Bayern Munich', 'Bayern'],
  ["M'gladbach", 'Gladbach'],
  ['Ein Frankfurt', 'Frankfurt'],
  ['FC Koln', 'Koeln'],
  ['Paris SG', 'Paris SG'],
  ['Ath Madrid', 'Atletico'],
  ['Sp Lisbon', 'Sporting'],
  ['AZ Alkmaar', 'AZ'],
  ['Guimaraes', 'Guimaraes'],
];

// Champions League clubs: [football-data.org spelling, API-Football spelling, ClubElo spelling as recalled].
// The pipeline compares football-data.org with ClubElo (to rate the club) and API-Football with football-data.org
// (referee, absences); every spelling of one club must give the same key.
const CL_CLUBS = [
  ['FC Red Bull Salzburg', 'Red Bull Salzburg', 'Salzburg'],
  ['SK Sturm Graz', 'Sturm Graz', 'Sturm Graz'],
  ['Celtic FC', 'Celtic', 'Celtic'],
  ['Rangers FC', 'Rangers', 'Rangers'],
  ['Olympiacos FC', 'Olympiakos Piraeus', 'Olympiakos'],
  ['Panathinaikos FC', 'Panathinaikos', 'Panathinaikos'],
  ['PAOK FC', 'PAOK', 'PAOK'],
  ['AEK Athens FC', 'AEK Athens FC', 'AEK'],
  ['Pafos FC', 'Pafos', 'Pafos'],
  ['Galatasaray SK', 'Galatasaray', 'Galatasaray'],
  ['Fenerbahçe SK', 'Fenerbahce', 'Fenerbahce'],
  ['Beşiktaş JK', 'Besiktas', 'Besiktas'],
  ['Club Brugge KV', 'Club Brugge KV', 'Brugge'],
  ['Royal Union Saint-Gilloise', 'Union St. Gilloise', 'St Gillis'],
  ['RSC Anderlecht', 'Anderlecht', 'Anderlecht'],
  ['SK Slavia Praha', 'Slavia Praha', 'Slavia Praha'],
  ['AC Sparta Praha', 'Sparta Praha', 'Sparta Praha'],
  ['FC Viktoria Plzeň', 'Viktoria Plzen', 'Plzen'],
  ['FK Crvena Zvezda', 'FK Crvena Zvezda', 'Crvena Zvezda'],
  ['GNK Dinamo Zagreb', 'Dinamo Zagreb', 'Dinamo Zagreb'],
  ['FC Shakhtar Donetsk', 'Shakhtar Donetsk', 'Shakhtar'],
  ['FC Dynamo Kyiv', 'Dynamo Kyiv', 'Dynamo Kyiv'],
  ['FC København', 'FC Copenhagen', 'Kobenhavn'],
  ['FC Midtjylland', 'FC Midtjylland', 'Midtjylland'],
  ['FK Bodø/Glimt', 'Bodo/Glimt', 'Bodo/Glimt'],
  ['Malmö FF', 'Malmo FF', 'Malmo'],
  ['BSC Young Boys', 'Young Boys', 'Young Boys'],
  ['FC Basel 1893', 'FC Basel', 'Basel'],
  ['Ferencvárosi TC', 'Ferencvarosi TC', 'Ferencvaros'],
  ['Qarabağ FK', 'Qarabag', 'Qarabag'],
  ['FC Kairat Almaty', 'Kairat Almaty', 'Kairat'],
  ['Maccabi Tel Aviv FC', 'Maccabi Tel Aviv', 'Maccabi Tel Aviv'],
  ['Legia Warszawa', 'Legia Warszawa', 'Legia'],
  ['Club Atlético de Madrid', 'Atletico Madrid', 'Atletico'],
  ['FC Bayern München', 'Bayern München', 'Bayern'],
  ['Paris Saint-Germain FC', 'Paris Saint Germain', 'Paris SG'],
  ['FC Internazionale Milano', 'Inter', 'Inter'],
  ['AC Milan', 'AC Milan', 'Milan'],
  ['Sporting Clube de Portugal', 'Sporting CP', 'Sporting'],
  ['Bayer 04 Leverkusen', 'Bayer Leverkusen', 'Leverkusen'],
  ['Borussia Dortmund', 'Borussia Dortmund', 'Dortmund'],
  ['Eintracht Frankfurt', 'Eintracht Frankfurt', 'Frankfurt'],
  ['LOSC Lille', 'Lille', 'Lille'],
  ['Athletic Club', 'Athletic Club', 'Athletic'],
  ['PSV', 'PSV Eindhoven', 'PSV'],
  ['Newcastle United FC', 'Newcastle', 'Newcastle'],
  ['Tottenham Hotspur FC', 'Tottenham', 'Tottenham'],
];

test('Champions League clubs: football-data.org, API-Football and ClubElo spellings of one club give one key', () => {
  const failures = CL_CLUBS.filter(([a, b, c]) => new Set([a, b, c].map((n) => resolver.key(n))).size !== 1);
  assert.deepEqual(failures, [], `different keys: ${JSON.stringify(failures)}`);
  // and different clubs never share a key
  const keys = CL_CLUBS.map(([a]) => resolver.key(a));
  assert.equal(new Set(keys).size, keys.length);
});

test('the built-in alias list has no conflicting entries and no group is empty', () => {
  assert.deepEqual(resolver.conflicts, []);
  assert.deepEqual(loaded.warnings, []);
  assert.ok(Object.keys(aliases).length > 150, `only ${Object.keys(aliases).length} groups`);
  for (const [name, list] of Object.entries(aliases)) assert.ok(list.length > 0, name);
});

test('Test 9: at least 40 known tricky name pairs are matched across the sources', () => {
  const pairs = [...FD_ORG_VS_CSV, ...CSV_VS_ELO];
  assert.ok(pairs.length >= 40, `only ${pairs.length} pairs`);
  const failures = pairs.filter(([a, b]) => resolver.key(a) !== resolver.key(b));
  assert.deepEqual(failures, [], `unmatched pairs: ${JSON.stringify(failures)}`);
});

test('canonical key rules', () => {
  assert.equal(canonicalKey('Arsenal FC'), 'arsenal');
  assert.equal(canonicalKey('Brighton & Hove Albion FC'), 'brighton and hove albion');
  assert.equal(canonicalKey('1. FC Köln'), 'koln');
  assert.equal(canonicalKey('Fortuna Düsseldorf'), 'fortuna dusseldorf');
  assert.equal(canonicalKey("Nott'm Forest"), 'nottm forest');
  assert.equal(canonicalKey('SV Werder Bremen'), 'werder bremen');
  assert.equal(canonicalKey('Brøndby IF'), 'brondby if');
  assert.equal(canonicalKey('SSC Napoli'), 'napoli');
  assert.equal(canonicalKey('FC'), 'fc'); // never reduce a name to nothing
});

test('the 20 football-data.org Premier League names resolve uniquely to the real CSV names', () => {
  // Distinct HomeTeam values of the real 2025/26 E0.csv.
  const csv = [
    'Liverpool', 'Aston Villa', 'Brighton', 'Sunderland', 'Tottenham', 'Wolves', 'Chelsea', "Nott'm Forest",
    'Man United', 'Leeds', 'West Ham', 'Man City', 'Bournemouth', 'Brentford', 'Burnley', 'Arsenal',
    'Crystal Palace', 'Everton', 'Fulham', 'Newcastle',
  ];
  const universe = new Set(csv.map((n) => resolver.key(n)));
  const fd = [
    ['Arsenal FC', 'Arsenal'], ['Aston Villa FC', 'Aston Villa'], ['AFC Bournemouth', 'Bournemouth'],
    ['Brentford FC', 'Brentford'], ['Brighton & Hove Albion FC', 'Brighton Hove'], ['Burnley FC', 'Burnley'],
    ['Chelsea FC', 'Chelsea'], ['Crystal Palace FC', 'Crystal Palace'], ['Everton FC', 'Everton'],
    ['Fulham FC', 'Fulham'], ['Leeds United FC', 'Leeds United'], ['Liverpool FC', 'Liverpool'],
    ['Manchester City FC', 'Man City'], ['Manchester United FC', 'Man United'], ['Newcastle United FC', 'Newcastle'],
    ['Nottingham Forest FC', 'Nottingham'], ['Sunderland AFC', 'Sunderland'], ['Tottenham Hotspur FC', 'Tottenham'],
    ['West Ham United FC', 'West Ham'], ['Wolverhampton Wanderers FC', 'Wolverhampton'],
  ];
  const seen = new Set();
  for (const [name, short] of fd) {
    const m = resolver.matchAny([name, short], universe);
    assert.ok(m.key, `${name} did not match (${m.how})`);
    assert.ok(universe.has(m.key));
    assert.ok(!seen.has(m.key), `${name} collided with another team`);
    seen.add(m.key);
  }
  assert.equal(seen.size, 20);
});

test('fuzzy fallback accepts a unique close name and rejects ambiguous or distant ones', () => {
  const bare = createResolver({});
  const kyiv = new Set(['dynamo kyiv', 'dynamo moscow', 'shakhtar donetsk']);
  const hit = bare.match('Dynamo Kiev', kyiv);
  assert.equal(hit.how, 'fuzzy');
  assert.equal(hit.key, 'dynamo kyiv');

  const twins = new Set(['stade rennais', 'stade rennes']);
  const amb = bare.match('Stade Renais', twins);
  assert.equal(amb.how, 'ambiguous');
  assert.equal(amb.key, null);

  assert.equal(bare.match('Totally Unknown Rovers', kyiv).how, 'none');
  // Different clubs with a shared city must not be merged on a weak score.
  assert.equal(bare.match('Real Madrid', new Set(['real sociedad', 'atletico madrid'])).key, null);
});

test('similarity helpers', () => {
  assert.equal(jaroWinkler('arsenal', 'arsenal'), 1);
  assert.ok(jaroWinkler('martha', 'marhta') > 0.96);
  assert.equal(tokenJaccard('a b c', 'c b a'), 1);
  assert.equal(tokenJaccard('a b', 'c d'), 0);
});

test('alias groups are conflict free and "_help" comment keys are ignored', () => {
  assert.deepEqual(resolver.conflicts, []);
  // keys starting with "_" are comments, not alias groups
  const r = createResolver({ _help: ['x'], Alpha: ['Beta'] });
  assert.equal(r.key('Beta'), 'alpha');
  assert.equal(r.key('x'), 'x');
  assert.equal(r.key('help'), 'help');
});
