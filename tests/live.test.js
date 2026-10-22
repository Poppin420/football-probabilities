// The live panel's data: one /matches request -> live.json (selection, change detection) and the pure page helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLive } from '../src/sources/footballDataOrg.js';
import { buildLiveFile, liveWindow, sameLive, selectLive } from '../src/pipeline/live.js';
import { checkOutput } from '../scripts/data-branch.mjs';
import { favouriteOf, liveBase, liveVerdict, outcomeOfScore } from '../public/util.js';

const NOW = new Date('2026-10-18T19:30:00Z');
const api = (id, status, kickoff, home = 1, away = 0, extra = {}) => ({
  id, status, utcDate: kickoff, minute: 63, lastUpdated: kickoff,
  competition: { code: 'PL', name: 'Premier League' },
  homeTeam: { id: id * 10, name: `Home ${id} FC`, shortName: `Home ${id}`, tla: 'HOM' },
  awayTeam: { id: id * 10 + 1, name: `Away ${id} FC`, shortName: `Away ${id}`, tla: 'AWY' },
  score: { winner: null, duration: 'REGULAR', fullTime: { home, away }, halfTime: { home: 0, away: 0 } },
  ...extra,
});

test('parseLive keeps the id, status, minute and the current score; drops matches without two known teams', () => {
  const json = { matches: [api(1, 'IN_PLAY', '2026-10-18T18:30:00Z', 2, 1), { id: 2, status: 'TIMED', utcDate: '2026-10-18T20:00:00Z', homeTeam: { id: null, name: null }, awayTeam: { name: 'B' }, competition: { code: 'CL' } }] };
  const { matches } = parseLive(json);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].score, { home: 2, away: 1, htHome: 0, htAway: 0 });
  assert.equal(matches[0].minute, 63);
  assert.equal(matches[0].code, 'PL');
  assert.throws(() => parseLive({}), /no "matches" array/);
});

test('selectLive: playing, half-time and recently finished matches only, sorted by kick-off', () => {
  const list = parseLive({ matches: [
    api(1, 'IN_PLAY', '2026-10-18T18:30:00Z'),
    api(2, 'PAUSED', '2026-10-18T18:00:00Z'),
    api(3, 'FINISHED', '2026-10-18T17:00:00Z'), // 2.5 h ago: still shown
    api(4, 'FINISHED', '2026-10-18T14:00:00Z'), // long over
    api(5, 'TIMED', '2026-10-18T21:00:00Z'), // not started
    api(6, 'POSTPONED', '2026-10-18T18:00:00Z'),
  ] }).matches;
  const out = selectLive(list, NOW);
  assert.deepEqual(out.map((m) => [m.id, m.state]), [[3, 'finished'], [2, 'half-time'], [1, 'live']]);
  assert.equal(out[0].home, 'Home 3');
  assert.equal(out[0].homeFull, 'Home 3 FC');
});

test('sameLive ignores the update time; liveWindow covers yesterday to tomorrow', () => {
  const a = buildLiveFile(parseLive({ matches: [api(1, 'IN_PLAY', '2026-10-18T18:30:00Z')] }).matches, NOW);
  const b = buildLiveFile(parseLive({ matches: [api(1, 'IN_PLAY', '2026-10-18T18:30:00Z')] }).matches, new Date(NOW.getTime() + 300000));
  const c = buildLiveFile(parseLive({ matches: [api(1, 'IN_PLAY', '2026-10-18T18:30:00Z', 2, 0)] }).matches, NOW);
  assert.equal(sameLive(a, b), true);
  assert.equal(sameLive(a, c), false);
  assert.equal(sameLive(null, a), false);
  assert.deepEqual(liveWindow(NOW), { from: '2026-10-17', to: '2026-10-19' });
});

test('the branch "live" is checked on its own: live.json only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-live-'));
  const settings = { branch: 'live', outDir: dir, partialRun: false };
  assert.throws(() => checkOutput(settings), /live.json is missing/);
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ schema: 2, matches: [] }));
  assert.throws(() => checkOutput(settings), /unexpected shape/);
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ schema: 1, updatedAt: 'x', matches: [] }));
  assert.equal(checkOutput(settings).generatedAt, 'x');
});

test('page helpers: where live.json is, the favourite, and the verdict', () => {
  assert.equal(liveBase({ OWNER: 'me', REPO: 'fp' }), 'https://raw.githubusercontent.com/me/fp/live');
  assert.equal(liveBase({ OWNER: 'me', REPO: 'fp', LIVE_BRANCH: 'x1' }), 'https://raw.githubusercontent.com/me/fp/x1');
  assert.equal(liveBase({ OWNER: 'YOUR_GITHUB_USERNAME', REPO: 'fp' }), null);
  assert.equal(liveBase({ DATA_URL: 'https://example.test/data' }), null);
  assert.equal(liveBase({ DATA_URL: 'https://example.test/data', LIVE_URL: 'https://example.test/live/' }), 'https://example.test/live');
  assert.deepEqual(favouriteOf({ home: 0.5, draw: 0.3, away: 0.2 }), { key: 'home', p: 0.5 });
  assert.equal(favouriteOf(null), null);
  assert.equal(outcomeOfScore({ home: 1, away: 1 }), 'draw');
  assert.equal(outcomeOfScore({ home: null, away: 1 }), null);
  const fav = { key: 'home', p: 0.5 };
  assert.equal(liveVerdict(fav, { home: 1, away: 0 }, 'live'), 'on');
  assert.equal(liveVerdict(fav, { home: 0, away: 0 }, 'live'), 'off');
  assert.equal(liveVerdict(fav, { home: 1, away: 0 }, 'finished'), 'won');
  assert.equal(liveVerdict(fav, { home: 1, away: 2 }, 'finished'), 'lost');
  assert.equal(liveVerdict(null, { home: 1, away: 0 }, 'live'), null);
});

test('Europa League source: parses the documented match shape, drops undecided ties, keeps knockout scores out of the Elo', async () => {
  const { parseMatches, createRapidEuropaClient } = await import('../src/sources/rapidEuropa.js');
  const team = (id, name) => ({ id, slug: null, name, shortName: name, code: name.slice(0, 3).toUpperCase(), crestUrl: 'x' });
  const m = (id, stage, round, hs, as) => ({ id, competition: 'uefa-europa-league', season: '2026-27', stage, round, kickoff: '2026-10-22T19:00:00Z', status: 'finished', minute: null, homeTeam: team(id, `H${id}`), awayTeam: team(id + 1000, `A${id}`), score: { home: hs, away: as }, venue: null });
  const json = { data: [m(1, 'League phase', 3, 2, 1), m(2, 'Knockout round play-offs', null, 1, 1), { ...m(3, null, null, null, null), homeTeam: { id: null, name: null } }], meta: { season: '2026-27', page: 1, limit: 200, total: 3 } };
  const p = parseMatches(json);
  assert.equal(p.matches.length, 2);
  assert.equal(p.skipped, 1);
  assert.equal(p.matches[0].stage, 'LEAGUE_PHASE');
  assert.throws(() => parseMatches({}), /no "data" array/);
  assert.throws(() => createRapidEuropaClient({ key: '' }), /RAPIDAPI_KEY/);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify(json), { status: 200, headers: { 'x-ratelimit-requests-remaining': '490', 'x-ratelimit-requests-limit': '500' } });
  };
  const client = createRapidEuropaClient({ key: 'k', baseUrl: 'https://eu.example.test', fetchImpl });
  const res = await client.results('EL', 2026);
  assert.match(calls[0].url, /season=2026-27/);
  assert.match(calls[0].url, /status=finished/);
  assert.equal(calls[0].headers['X-RapidAPI-Host'], 'eu.example.test');
  assert.equal(res.results.find((r) => r.id === 1).x, 2);
  assert.equal(res.results.find((r) => r.id === 2).x, null, 'knockout score is not used');
  assert.equal(client.state.remaining, 490);
  assert.equal(calls.length, 1, 'one page when the total fits');
});
