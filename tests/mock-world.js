// A synthetic "world" served by local HTTP mock servers so the whole pipeline
// (refresh.mjs logic) can be tested without the internet.
// Team names are the real Premier League spellings used by the three sources.

import http from 'node:http';
import { mulberry32, normal, poissonSample, nbSample } from './helpers.js';

// [CSV name, football-data.org name, football-data.org shortName]
export const CORE = [
  ['Liverpool', 'Liverpool FC', 'Liverpool'],
  ['Aston Villa', 'Aston Villa FC', 'Aston Villa'],
  ['Brighton', 'Brighton & Hove Albion FC', 'Brighton Hove'],
  ['Tottenham', 'Tottenham Hotspur FC', 'Tottenham'],
  ['Wolves', 'Wolverhampton Wanderers FC', 'Wolverhampton'],
  ['Chelsea', 'Chelsea FC', 'Chelsea'],
  ["Nott'm Forest", 'Nottingham Forest FC', 'Nottingham'],
  ['Man United', 'Manchester United FC', 'Man United'],
  ['West Ham', 'West Ham United FC', 'West Ham'],
  ['Man City', 'Manchester City FC', 'Man City'],
  ['Bournemouth', 'AFC Bournemouth', 'Bournemouth'],
  ['Brentford', 'Brentford FC', 'Brentford'],
  ['Arsenal', 'Arsenal FC', 'Arsenal'],
  ['Crystal Palace', 'Crystal Palace FC', 'Crystal Palace'],
  ['Everton', 'Everton FC', 'Everton'],
  ['Fulham', 'Fulham FC', 'Fulham'],
  ['Newcastle', 'Newcastle United FC', 'Newcastle'],
];
const LUTON = ['Luton', 'Luton Town FC', 'Luton Town'];
const SHEFF = ['Sheffield United', 'Sheffield United FC', 'Sheffield Utd'];
const BURNLEY = ['Burnley', 'Burnley FC', 'Burnley'];
const IPSWICH = ['Ipswich', 'Ipswich Town FC', 'Ipswich Town'];
const LEICESTER = ['Leicester', 'Leicester City FC', 'Leicester City'];
const SOTON = ['Southampton', 'Southampton FC', 'Southampton'];
const LEEDS = ['Leeds', 'Leeds United FC', 'Leeds United'];
const SUNDERLAND = ['Sunderland', 'Sunderland AFC', 'Sunderland'];

export const SEASON_TEAMS = {
  2324: [...CORE, LUTON, SHEFF, BURNLEY],
  2425: [...CORE, IPSWICH, LEICESTER, SOTON],
  2526: [...CORE, LEEDS, BURNLEY, SUNDERLAND],
  // 2026/27: Ipswich, Leicester and Southampton are back -> "promoted"
  2627: [...CORE, IPSWICH, LEICESTER, SOTON],
};
export const PROMOTED_2627 = ['Ipswich', 'Leicester', 'Southampton'];

const REFEREES = ['M Oliver', 'A Taylor', 'S Attwell', 'P Tierney', 'C Pawson', 'D Coote', 'R Jones', 'T Robinson', 'J Gillett', 'S Hooper'];

function fmtDate(d) {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** Circle-method double round robin: array of rounds, each [home, away][] */
function schedule(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const a = idx[i];
      const b = idx[n - 1 - i];
      round.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(round);
    idx.splice(1, 0, idx.pop());
  }
  return [...rounds, ...rounds.map((rd) => rd.map(([h, a]) => [a, h]))];
}

export function buildWorld({ seed = 2026, now = new Date('2026-10-18T10:00:00Z') } = {}) {
  const rand = mulberry32(seed);
  const htRand = mulberry32(seed + 7); // half-time goals: a separate stream, so every other number of the world stays the same
  const strength = new Map();
  const strengthOf = (name) => {
    if (!strength.has(name)) {
      strength.set(name, { att: 0.22 * normal(rand), def: 0.2 * normal(rand), corn: 0.18 * normal(rand), card: 0.15 * normal(rand) });
    }
    return strength.get(name);
  };
  const header =
    'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A';

  const csv = {};
  for (const code of Object.keys(SEASON_TEAMS)) {
    const startYear = 2000 + Number(code.slice(0, 2));
    const teams = SEASON_TEAMS[code];
    const rounds = schedule(teams.length);
    const lastRound = code === '2627' ? 9 : rounds.length; // 9 match days so far this season
    const lines = [header];
    for (let r = 0; r < lastRound; r++) {
      const date = new Date(Date.UTC(startYear, 7, 10 + 7 * r));
      for (const [h, a] of rounds[r]) {
        const hn = teams[h][0];
        const an = teams[a][0];
        const sh = strengthOf(hn);
        const sa = strengthOf(an);
        const lam = Math.exp(0.12 + 0.25 + sh.att + sa.def);
        const mu = Math.exp(0.12 + sa.att + sh.def);
        const x = poissonSample(rand, lam);
        const y = poissonSample(rand, mu);
        const hc = nbSample(rand, Math.exp(1.6 + 0.12 + sh.corn - sa.corn * 0.5), 25);
        const ac = nbSample(rand, Math.exp(1.6 + sa.corn - sh.corn * 0.5), 25);
        const hy = nbSample(rand, Math.exp(0.62 + sh.card), 60);
        const ay = nbSample(rand, Math.exp(0.66 + sa.card), 60);
        const hr = poissonSample(rand, 0.05);
        const ar = poissonSample(rand, 0.06);
        const hs = poissonSample(rand, lam * 8) + 2;
        const as = poissonSample(rand, mu * 8) + 2;
        const ref = REFEREES[Math.floor(rand() * REFEREES.length)];
        const res = x > y ? 'H' : x < y ? 'A' : 'D';
        let hth = 0;
        for (let k = 0; k < x; k++) if (htRand() < 0.45) hth++;
        let hta = 0;
        for (let k = 0; k < y; k++) if (htRand() < 0.45) hta++;
        const htr = hth > hta ? 'H' : hth < hta ? 'A' : 'D';
        lines.push(
          `E0,${fmtDate(date)},15:00,${hn},${an},${x},${y},${res},${hth},${hta},${htr},${ref},${hs},${as},${Math.min(hs, x + 3)},${Math.min(as, y + 3)},10,11,${hc},${ac},${hy},${ay},${hr},${ar},2.1,3.4,3.6`,
        );
      }
    }
    csv[code] = lines.join('\n') + '\n';
  }

  // fixtures for the next 7 days
  const t27 = SEASON_TEAMS['2627'];
  const byCsv = new Map(t27.map((t) => [t[0], t]));
  const team = (t, id) => ({ id, name: t[1], shortName: t[2], tla: t[0].slice(0, 3).toUpperCase() });
  const pairs = [
    ['Arsenal', 'Chelsea'], ['Liverpool', 'Man City'], ['Man United', 'Tottenham'], ['Newcastle', 'Ipswich'],
    ['Leicester', 'Everton'], ['Fulham', 'Southampton'], ['Brentford', 'Bournemouth'], ['West Ham', "Nott'm Forest"],
  ];
  const kick = ['2026-10-18T14:00:00Z', '2026-10-19T15:30:00Z', '2026-10-20T19:00:00Z', '2026-10-21T19:45:00Z',
    '2026-10-22T19:45:00Z', '2026-10-23T19:00:00Z', '2026-10-24T11:30:00Z', '2026-10-24T14:00:00Z'];
  let nextId = 540000;
  const matches = pairs.map(([h, a], i) => ({
    id: nextId++,
    utcDate: kick[i],
    status: i % 2 === 0 ? 'TIMED' : 'SCHEDULED',
    matchday: 9,
    stage: 'REGULAR_SEASON',
    homeTeam: team(byCsv.get(h), 100 + i),
    awayTeam: team(byCsv.get(a), 200 + i),
    score: { winner: null, fullTime: { home: null, away: null } },
    referees: i === 0 ? [{ id: 9, name: 'Michael Oliver', type: 'REFEREE', nationality: 'England' }] : [],
  }));
  // a brand-new club known only to ClubElo -> matched through the Elo universe
  matches.push({
    id: nextId++,
    utcDate: '2026-10-25T09:00:00Z',
    status: 'TIMED',
    homeTeam: team(byCsv.get('Arsenal'), 12),
    awayTeam: { id: 999, name: 'Coventry City FC', shortName: 'Coventry', tla: 'COV' },
    referees: [],
  });
  // a team nobody knows -> must be skipped and listed in the warnings
  matches.push({
    id: nextId++,
    utcDate: '2026-10-21T18:00:00Z',
    status: 'TIMED',
    homeTeam: { id: 998, name: 'Zzyzx United FC', shortName: 'Zzyzx', tla: 'ZZY' },
    awayTeam: team(byCsv.get('Chelsea'), 13),
    referees: [],
  });
  // a match outside the 7-day window and one already finished are ignored
  matches.push({
    id: nextId++,
    utcDate: '2026-11-07T15:00:00Z',
    status: 'TIMED',
    homeTeam: team(byCsv.get('Fulham'), 14),
    awayTeam: team(byCsv.get('Everton'), 15),
    referees: [],
  });

  // scorers: two listed players per club
  const scorerList = (goalsA, goalsB, season) =>
    t27.flatMap((t, i) => [
      { player: { id: 1000 + i * 3, name: `${t[2]} Striker`, position: 'Offence' }, team: team(t, 300 + i), playedMatches: 9, goals: goalsA, assists: 2, penalties: 1 },
      { player: { id: 1001 + i * 3, name: `${t[2]} Winger`, position: 'Offence' }, team: team(t, 300 + i), playedMatches: 9, goals: goalsB, assists: null, penalties: 0 },
    ]).map((s) => ({ ...s, _season: season }));
  const scorersCurrent = scorerList(6, 3, 2026);
  const scorersPrevious = scorerList(18, 9, 2025);

  const eloRows = [
    ['Man City', 'ENG', 2040], ['Liverpool', 'ENG', 2010], ['Arsenal', 'ENG', 2030], ['Chelsea', 'ENG', 1900], ['Man United', 'ENG', 1850],
    ['Tottenham', 'ENG', 1860], ['Newcastle', 'ENG', 1870], ['Aston Villa', 'ENG', 1830], ['Brighton', 'ENG', 1800], ['West Ham', 'ENG', 1760],
    ['Forest', 'ENG', 1770], ['Wolves', 'ENG', 1720], ['Everton', 'ENG', 1750], ['Fulham', 'ENG', 1780], ['Brentford', 'ENG', 1790],
    ['Bournemouth', 'ENG', 1785], ['Crystal Palace', 'ENG', 1795], ['Ipswich', 'ENG', 1650], ['Leicester', 'ENG', 1670], ['Southampton', 'ENG', 1660],
    ['Coventry', 'ENG', 1640], ['Bayern', 'GER', 2000], ['Dortmund', 'GER', 1880],
  ];
  const elo = ['Rank,Club,Country,Level,Elo,From,To', ...eloRows.map((r, i) => `${i + 1},${r[0]},${r[1]},1,${r[2]},2026-10-01,2026-10-30`)].join('\n') + '\n';

  const teams = t27.map((t, i) => team(t, 100 + i));

  return { csv, fixtures: matches, scorersCurrent, scorersPrevious, elo, teams, now, strength };
}

/**
 * Start a mock server. behaviour can be changed between runs:
 *   server.set({ fixturesStatus: 500, csvCurrentStatus: 500, previousScorersStatus: 403 })
 * Returns { port, url, hits, set, close }.
 */
export async function startMockServer(world, initial = {}, extra = null) {
  const behaviour = { fixturesStatus: 200, csvCurrentStatus: 200, previousScorersStatus: 403, eloStatus: 200, apiFootball: 'ok', groq: 'ok', ...initial };
  const hits = [];
  const groqCalls = []; // every chat completion request that arrived
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(url.pathname + url.search);
    const send = (status, body, type = 'application/json', extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/groq/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: { message: 'bad json' } });
        }
        const call = {
          auth: req.headers.authorization,
          model: body.model,
          system: body.messages?.[0]?.content,
          user: body.messages?.[1]?.content,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          max_completion_tokens: body.max_completion_tokens,
          reasoning_effort: body.reasoning_effort,
          include_reasoning: body.include_reasoning,
        };
        groqCalls.push(call);
        if (call.auth !== 'Bearer groq-test') return send(401, { error: { message: 'Invalid API Key' } });
        let r;
        try {
          r = (behaviour.groqReply || groqReply)(call, groqCalls.length, behaviour);
        } catch (err) {
          return send(500, { error: { message: `mock could not answer: ${err.message}` } }); // never leave the request hanging
        }
        if (r.status !== 200) return send(r.status, { error: { message: r.message || 'error', code: r.code } }, 'application/json', r.status === 429 ? { 'retry-after': '1' } : {});
        return send(200, {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: call.model,
          choices: [{ index: 0, message: { role: 'assistant', content: r.content }, finish_reason: r.finish || 'stop' }],
          usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
        });
      });
      return;
    }
    // Extra routes of a richer world (Phase 3 tests): handled first, return true when they answered.
    if (extra && extra(req, url, send, behaviour)) return;
    let m;
    if ((m = /^\/mmz4281\/(\d{4})\/E0\.csv$/.exec(url.pathname))) {
      if (m[1] === '2627' && behaviour.csvCurrentStatus !== 200) return send(behaviour.csvCurrentStatus, 'error', 'text/plain');
      if (!world.csv[m[1]]) return send(404, 'not found', 'text/plain');
      return send(200, Buffer.from(world.csv[m[1]], 'latin1'), 'text/csv');
    }
    if (req.url.startsWith('/v4/competitions/PL/matches')) {
      if (req.headers['x-auth-token'] !== 'test-token') return send(403, { message: 'bad token' });
      if (behaviour.fixturesStatus !== 200) return send(behaviour.fixturesStatus, { message: 'upstream down' });
      return send(200, { filters: {}, resultSet: { count: world.fixtures.length }, competition: { code: 'PL' }, matches: world.fixtures },
        'application/json', { 'x-requests-available-minute': '9', 'x-requestcounter-reset': '60' });
    }
    if (url.pathname === '/v4/competitions/PL/teams') {
      if (req.headers['x-auth-token'] !== 'test-token') return send(403, { message: 'bad token' });
      return send(200, { count: world.teams.length, competition: { code: 'PL' }, teams: world.teams });
    }
    if ((m = /^\/v4\/competitions\/PL\/scorers$/.exec(url.pathname))) {
      const season = url.searchParams.get('season');
      if (season === '2025' && behaviour.previousScorersStatus !== 200) return send(behaviour.previousScorersStatus, { message: 'restricted' });
      const list = season === '2026' ? world.scorersCurrent : world.scorersPrevious;
      return send(200, { count: list.length, filters: { season, limit: Number(url.searchParams.get('limit')) }, scorers: list });
    }
    if (url.pathname === '/groq/models') {
      if (req.headers.authorization !== 'Bearer groq-test') return send(401, { error: { message: 'Invalid API Key' } });
      return send(200, { object: 'list', data: [{ id: 'openai/gpt-oss-120b', active: true }, { id: 'openai/gpt-oss-20b', active: true }, { id: 'retired-model', active: false }] });
    }
    if (url.pathname === '/apif/fixtures' || url.pathname === '/apif/injuries') {
      // API-Football answers HTTP 200 even when it refuses: the body decides.
      const hdr = { 'x-ratelimit-requests-remaining': '93' };
      if (req.headers['x-apisports-key'] !== 'apif-test') {
        return send(200, { errors: { token: 'Error/Missing application key.' }, results: 0, response: [] }, 'application/json', hdr);
      }
      if (behaviour.apiFootball === 'plan') {
        return send(200, { errors: { plan: 'Free plans do not have access to this season, try from 2021 to 2023.' }, results: 0, response: [] }, 'application/json', hdr);
      }
      if (url.pathname === '/apif/injuries') return send(200, { errors: [], results: 0, response: [] }, 'application/json', hdr);
      const kick = Date.parse('2026-10-19T14:00:00Z');
      const fixture = (id, home, away, referee) => ({
        fixture: { id, referee, timestamp: Math.floor((kick + id * 3600000) / 1000), date: new Date(kick + id * 3600000).toISOString(), status: { short: 'NS' } },
        league: { id: 39, season: 2026 },
        teams: { home: { id: id * 10, name: home }, away: { id: id * 10 + 1, name: away } },
      });
      return send(200, { errors: [], results: 3, paging: { current: 1, total: 1 }, response: [fixture(1, 'Arsenal', 'Chelsea', 'Michael Oliver, England'), fixture(2, 'Liverpool', 'Man City', null), fixture(3, 'Everton', 'Fulham', 'A. Taylor, England')] }, 'application/json', hdr);
    }
    if (/^\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) {
      if (behaviour.eloStatus !== 200) return send(behaviour.eloStatus, 'down', 'text/plain');
      return send(200, world.elo, 'text/csv');
    }
    return send(404, { message: 'no such route ' + url.pathname });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    groqCalls,
    set: (patch) => Object.assign(behaviour, patch),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Groq chat completions (mock). The reply is built ONLY from the numbers of the
// JSON the pipeline sent, like a well-behaved model would; behaviours:
//   ok | badNumbers | english | betting | long | cut | list | 429 | primary429 | 500 | primary500
//   | primaryGone (404) | primaryDecommissioned (400) | bothGone (404)
const PRIMARY = 'openai/gpt-oss-120b';

export function groqReply(call, n, behaviour) {
  const mode = behaviour.groq;
  if (mode === '429') return { status: 429, message: 'rate limit' };
  if (mode === 'primary429' && call.model === PRIMARY) return { status: 429, message: 'rate limit' };
  if (mode === 'primaryGone' && call.model === PRIMARY) return { status: 404, message: `The model \`${PRIMARY}\` does not exist or you do not have access to it.`, code: 'model_not_found' };
  if (mode === 'primaryDecommissioned' && call.model === PRIMARY) return { status: 400, message: `The model \`${PRIMARY}\` has been decommissioned and is no longer supported.`, code: 'model_decommissioned' };
  if (mode === 'bothGone') return { status: 404, message: 'The model does not exist or you do not have access to it.', code: 'model_not_found' };
  if (mode === '500') return { status: 500, message: 'boom' };
  if (mode === 'primary500' && call.model === PRIMARY) return { status: 500, message: 'boom' };
  let p;
  try {
    p = JSON.parse(call.user);
  } catch {
    return { status: 400, message: 'user message is not JSON' };
  }
  if (mode === 'english') return { status: 200, content: `${p.home} are favourites with ${p.x12.home}% to win. Over 2.5 goals is ${p.ou.over}% likely.` };
  const s1 = `Φαβορί είναι ο ${p.home} με ${p.x12.home}% έναντι ${p.x12.away}% του ${p.away}, ενώ η ισοπαλία έχει ${p.x12.draw}%.`;
  const s2 = `Στα γκολ, το over ${p.ou.line} έχει ${mode === 'badNumbers' ? 87 : p.ou.over}%, το GG ${p.btts}% και το πιο πιθανό σκορ είναι το ${p.scores[0].s}.`;
  const s3 = p.corners ? `Τα κόρνερ αναμένονται κοντά στα ${p.corners.avg} και το over ${p.corners.line} είναι ${p.corners.over}%.` : null;
  const s4 = p.flags.length ? `Περιορισμός: ${p.flags[0]}.` : 'Οι εκτιμήσεις είναι στατιστικές και όχι βέβαιες.';
  let content = [s1, s2, s3, s4].filter(Boolean).join(' ');
  if (mode === 'betting') content += ' Αξίζει ένα στοίχημα στον γηπεδούχο.';
  if (mode === 'long') content += ' Ένα πέμπτο σχόλιο χωρίς αριθμούς. Και ένα έκτο σχόλιο χωρίς αριθμούς.';
  if (mode === 'list') content = [s1, s2, s3, s4].filter(Boolean).map((t) => `- ${t}`).join('\n');
  if (mode === 'cut') return { status: 200, content: content.slice(0, content.length - 25), finish: 'length' };
  return { status: 200, content };
}
