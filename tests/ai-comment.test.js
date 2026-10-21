// Phase 2: the Greek match comment (Groq). The maths never uses the model; these
// tests check the guard rails around it: prompt sent unchanged, the numbers
// check, the cache, the rate-limit policy and the integration in the refresh.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld, startMockServer, groqReply } from './mock-world.js';
import { largestRemainder } from '../public/format.js';

// These tests exercise the downloaded-ClubElo path (the mock server serves ClubElo); the own-Elo path has its own tests.
process.env.ELO_SOURCE = 'clubelo';

const world = buildWorld();
const server = await startMockServer(world);
process.env.FD_ORG_BASE = `${server.url}/v4`;
process.env.FD_CSV_BASE = `${server.url}/mmz4281`;
process.env.ELO_BASE = server.url;
process.env.GROQ_BASE = `${server.url}/groq`;
process.env.FD_ORG_MIN_INTERVAL_MS = '0';
process.env.CSV_PAUSE_MS = '0';
process.env.HTTP_BACKOFF_MS = '0';
const { runRefresh } = await import('../src/pipeline/refresh.js');
const ai = await import('../src/pipeline/aiComment.js');
const groq = await import('../src/sources/groq.js');
const { chatComplete, loadSystemPrompt, DEFAULT_MODEL, FALLBACK_MODEL } = groq;
after(() => server.close());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = path.join(ROOT, 'aliases.json');
const PROMPT_FILE = path.join(ROOT, 'prompts', 'ai-comment.system.txt');
const NOW = new Date('2026-10-18T10:00:00Z');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `fp-ai-${label}-`));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const quiet = { log() {}, error() {}, warn() {} };
const state = {};

// PROMPT 2 exactly as the user wrote it. The file in prompts/ must never differ.
const PROMPT_2 = `Είσαι αναλυτής ποδοσφαίρου. Θα λάβεις JSON με αριθμούς που υπολόγισε
στατιστικό μοντέλο για έναν αγώνα. Γράψε ανάλυση στα ελληνικά, το πολύ 4
σύντομες προτάσεις.

Κανόνες:
1. Χρησιμοποίησε ΜΟΝΟ αριθμούς που υπάρχουν στο JSON, ως ακέραια
   ποσοστά. Μην επινοείς τραυματισμούς, φόρμα, ειδήσεις, διαιτητή ή
   οτιδήποτε άλλο δεν υπάρχει στο JSON.
2. Πρόταση 1: ποιος είναι φαβορί και πόσο ξεκάθαρα (1Χ2). Πρόταση 2:
   γκολ (over/under 2.5, GG, πιο πιθανό σκορ). Πρόταση 3: κόρνερ, κάρτες
   ή σκόρερ, μόνο αν υπάρχουν στο JSON. Πρόταση 4: ένας περιορισμός από
   το πεδίο "flags", αν υπάρχει.
3. Ουδέτερος τόνος. Καμία προτροπή για στοιχηματισμό και καμία
   βεβαιότητα για το αποτέλεσμα.
Απάντησε μόνο με το κείμενο, χωρίς τίτλους ή λίστες.`;

/** A minimal match with every field the payload reads. */
function fakeMatch(i, kickoff, extra = {}) {
  return {
    id: 1000 + i,
    kickoff,
    homeName: `Alpha ${i}`,
    awayName: `Beta ${i}`,
    flags: { promotedHome: false, promotedAway: false, fewDataHome: false, fewDataAway: false, lowConfidence: false },
    goals: {
      oneX2: { home: 0.46, draw: 0.24, away: 0.3 },
      totals: [
        { line: 1.5, over: 0.8, under: 0.2 },
        { line: 2.5, over: 0.58, under: 0.42 },
      ],
      btts: { yes: 0.6, no: 0.4 },
      correctScores: [
        { score: '1-1', p: 0.11 },
        { score: '2-1', p: 0.09 },
        { score: '1-0', p: 0.08 },
        { score: '0-0', p: 0.07 },
      ],
      expected: { home: 1.67, away: 1.33, total: 3 },
    },
    corners: { totals: [{ line: 9.5, over: 0.63, under: 0.37 }], mean: { home: 6, away: 5, total: 10.97 } },
    cards: { totals: [{ line: 3.5, over: 0.51, under: 0.49 }], mean: { total: 3.7 } },
    scorers: null,
    analysis: { text: 'template text', source: 'template' },
    ...extra,
  };
}

const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600e3).toISOString();

/** In-process stand-in for Groq, built on the same reply generator as the mock server. */
function fakeChat(mode = 'ok', log = []) {
  return async ({ model, system, user }) => {
    log.push({ model, system, user });
    const r = groqReply({ model, user }, log.length, { groq: mode });
    if (r.status !== 200) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return { text: r.content, model, finishReason: r.finish || 'stop' };
  };
}

// ---------------------------------------------------------------- prompt --

test('the system prompt file is PROMPT 2, byte for byte', () => {
  const onDisk = fs.readFileSync(PROMPT_FILE, 'utf8');
  assert.equal(onDisk.replace(/\r\n/g, '\n').replace(/\n$/, ''), PROMPT_2);
  assert.equal(loadSystemPrompt(PROMPT_FILE).text, PROMPT_2);
});

test('prompt loader: CRLF and exactly one final newline are normalised, nothing else', () => {
  const dir = tmp('prompt');
  const f = path.join(dir, 'p.txt');
  fs.writeFileSync(f, 'Γραμμή 1\r\nΓραμμή 2\r\n\r\n');
  assert.equal(loadSystemPrompt(f).text, 'Γραμμή 1\nΓραμμή 2\n'); // only ONE newline removed
  fs.writeFileSync(f, '   \n');
  assert.equal(loadSystemPrompt(f), null);
  assert.equal(loadSystemPrompt(path.join(dir, 'missing.txt')), null);
});

// ----------------------------------------------------------- Groq client --

test('chatComplete: system prompt unchanged, user = JSON, temperature 0.3, key only in the header', async () => {
  server.groqCalls.length = 0;
  server.set({ groq: 'ok' });
  const system = loadSystemPrompt(PROMPT_FILE).text;
  const user = ai.buildPayload(fakeMatch(1, hoursFromNow(5))).json;
  const res = await chatComplete({ key: 'groq-test', model: DEFAULT_MODEL, system, user });
  assert.equal(server.groqCalls.length, 1);
  const call = server.groqCalls[0];
  assert.equal(call.auth, 'Bearer groq-test');
  assert.equal(call.system, PROMPT_2);
  assert.equal(call.user, user);
  assert.equal(call.model, DEFAULT_MODEL);
  assert.equal(call.temperature, 0.3);
  assert.match(res.text, /Φαβορί/);
  assert.equal(res.finishReason, 'stop');
});

test('models: the retired Llama models are gone from the defaults; gpt-oss gets room for its thinking, other models the plain 220 tokens', async () => {
  // Pinned on purpose: changing a default model must be a deliberate edit (Groq retires models regularly).
  assert.equal(DEFAULT_MODEL, 'openai/gpt-oss-120b');
  assert.equal(FALLBACK_MODEL, 'openai/gpt-oss-20b');
  assert.equal(groq.isReasoningModel('openai/gpt-oss-20b'), true);
  assert.equal(groq.isReasoningModel('qwen/qwen3.8-27b'), false);
  assert.equal(groq.isReasoningModel(undefined), false);
  assert.equal(groq.MAX_TOKENS, 220);
  assert.deepEqual(groq.modelSettings('openai/gpt-oss-120b'), { maxTokens: 620, extra: { reasoning_effort: 'low', include_reasoning: false } });
  assert.deepEqual(groq.modelSettings('qwen/qwen3.8-27b'), { maxTokens: 220, extra: {} });

  server.groqCalls.length = 0;
  server.set({ groq: 'ok' });
  const user = ai.buildPayload(fakeMatch(1, hoursFromNow(5))).json; // the mock answers from the numbers it is sent
  await chatComplete({ key: 'groq-test', model: DEFAULT_MODEL, system: 's', user });
  await chatComplete({ key: 'groq-test', model: FALLBACK_MODEL, system: 's', user });
  await chatComplete({ key: 'groq-test', model: 'qwen/qwen3.8-27b', system: 's', user });
  await chatComplete({ key: 'groq-test', model: DEFAULT_MODEL, system: 's', user, maxTokens: 100 }); // an explicit value wins
  const [big, small, other, explicit] = server.groqCalls;
  for (const c of [big, small]) {
    assert.equal(c.max_completion_tokens, 620);
    assert.equal(c.max_tokens, undefined, 'the deprecated name is not sent');
    assert.equal(c.reasoning_effort, 'low');
    assert.equal(c.include_reasoning, false);
  }
  assert.equal(other.max_completion_tokens, 220);
  assert.equal(other.reasoning_effort, undefined);
  assert.equal(other.include_reasoning, undefined);
  assert.equal(explicit.max_completion_tokens, 100);
});

test('chatComplete: 429 is thrown at once (no waiting), 401 and a missing key are errors', async () => {
  server.set({ groq: '429' });
  const t0 = Date.now();
  await assert.rejects(chatComplete({ key: 'groq-test', model: DEFAULT_MODEL, system: 's', user: '{}' }), (e) => e.status === 429);
  assert.ok(Date.now() - t0 < 1500, 'must not wait for Retry-After');
  server.set({ groq: 'ok' });
  await assert.rejects(chatComplete({ key: 'wrong', model: DEFAULT_MODEL, system: 's', user: '{}' }), (e) => e.status === 401);
  await assert.rejects(chatComplete({ key: '', model: DEFAULT_MODEL, system: 's', user: '{}' }), /GROQ_API_KEY/);
});

// --------------------------------------------------------------- payload --

test('payload: integer percentages that add up, lines spelled out, flags, well under 350 tokens', () => {
  const { payload, json, tokens, dropped } = ai.buildPayload(fakeMatch(7, hoursFromNow(3)));
  assert.deepEqual(payload.x12, { home: 46, draw: 24, away: 30 });
  assert.equal(payload.x12.home + payload.x12.draw + payload.x12.away, 100);
  assert.deepEqual(payload.ou, { line: 2.5, over: 58, under: 42 });
  assert.equal(payload.btts, 60);
  assert.deepEqual(payload.scores, [{ s: '1-1', p: 11 }, { s: '2-1', p: 9 }, { s: '1-0', p: 8 }]);
  assert.deepEqual(payload.exp_goals, { home: 1.67, away: 1.33 });
  assert.deepEqual(payload.corners, { avg: 11, line: 9.5, over: 63 });
  assert.deepEqual(payload.cards, { avg: 3.7, line: 3.5, over: 51 });
  assert.deepEqual(payload.flags, []);
  assert.ok('flags' in payload, 'PROMPT 2 refers to the field "flags"');
  assert.ok(tokens <= 350 && dropped.length === 0, `tokens ${tokens}`);
  assert.equal(json, JSON.stringify(payload));
  assert.ok(!json.includes(' '.repeat(2)));
});

test('payload: flags in Greek, scorers top 3, optional parts dropped (scorers first) when over budget', () => {
  const scorers = {
    home: [{ name: 'A. Striker', anytime: 0.31 }, { name: 'B. Winger', anytime: 0.12 }],
    away: [{ name: 'C. Forward', anytime: 0.22 }, { name: 'D. Mid', anytime: 0.05 }],
  };
  const m = fakeMatch(2, hoursFromNow(3), {
    scorers,
    flags: { promotedHome: true, promotedAway: false, fewDataHome: true, fewDataAway: false, lowConfidence: true },
  });
  const full = ai.buildPayload(m);
  assert.deepEqual(full.payload.scorers.map((s) => [s.n, s.p]), [['A. Striker', 31], ['C. Forward', 22], ['B. Winger', 12]]);
  assert.equal(full.payload.flags.length, 3);
  assert.match(full.payload.flags[0], /^νεοφώτιστη ομάδα \(Alpha 2\)/);
  assert.equal(full.payload.flags[1], 'χαμηλή βεβαιότητα του μοντέλου');
  assert.match(full.payload.flags[2], /χωρίς γνωστές συνθέσεις/);

  const small = ai.buildPayload(m, { maxTokens: full.tokens - 5 });
  assert.deepEqual(small.dropped, ['scorers']);
  assert.ok(!('scorers' in small.payload) && 'cards' in small.payload);
  const tiny = ai.buildPayload(m, { maxTokens: 60 });
  assert.deepEqual(tiny.dropped, ['scorers', 'cards', 'corners', 'scores']);
  assert.equal(tiny.payload.scores.length, 1);
  assert.ok('flags' in tiny.payload, 'flags are never dropped');
});

test('cache key: depends on prompt version, league, match id and the rounded numbers', () => {
  const { json } = ai.buildPayload(fakeMatch(1, hoursFromNow(3)));
  const base = { promptHash: 'aaaa', league: 'PL', matchId: 1001, json };
  const k = ai.cacheKey(base);
  assert.match(k, /^[0-9a-f]{40}$/);
  assert.equal(ai.cacheKey({ ...base }), k);
  assert.notEqual(ai.cacheKey({ ...base, promptHash: 'bbbb' }), k);
  assert.notEqual(ai.cacheKey({ ...base, league: 'BL1' }), k);
  assert.notEqual(ai.cacheKey({ ...base, matchId: 1002 }), k);
  const moved = ai.buildPayload(fakeMatch(1, hoursFromNow(3), { goals: { ...fakeMatch(1).goals, btts: { yes: 0.61, no: 0.39 } } }));
  assert.notEqual(ai.cacheKey({ ...base, json: moved.json }), k);
  // the same percentages with different unrounded values give the same key (cache hit)
  const same = ai.buildPayload(fakeMatch(1, hoursFromNow(3), { goals: { ...fakeMatch(1).goals, btts: { yes: 0.6004, no: 0.3996 } } }));
  assert.equal(ai.cacheKey({ ...base, json: same.json }), k);
});

// ------------------------------------------------------------- validator --

const PAYLOAD = ai.buildPayload(fakeMatch(1, hoursFromNow(3))).payload;
const GOOD =
  'Φαβορί είναι η Alpha 1 με 46% έναντι 30% της Beta 1, ενώ η ισοπαλία έχει 24%. ' +
  'Στα γκολ, το over 2,5 έχει 58%, το GG 60% και το πιο πιθανό σκορ είναι το 1-1. ' +
  'Τα κόρνερ αναμένονται κοντά στα 11 και το over 9,5 είναι 63%. ' +
  'Οι εκτιμήσεις είναι στατιστικές και όχι βέβαιες.';

test('validator: a faithful Greek comment passes (decimal comma, 1Χ2 and market lines allowed)', () => {
  const r = ai.validateComment(GOOD, PAYLOAD);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.text, GOOD);
  assert.equal(r.truncated, false);
  // "1Χ2" (Greek chi, Latin X, spaces) is a market name, not a number
  for (const mk of ['1Χ2', '1X2', '1x2', '1 Χ 2']) {
    const r2 = ai.validateComment(GOOD.replace('Φαβορί', `Στο ${mk} φαβορί`), PAYLOAD);
    assert.equal(r2.ok, true, `${mk}: ${r2.reason}`);
  }
  // decimal numbers of the payload may be written with a comma or a dot
  const g = ai.validateComment('Τα αναμενόμενα γκολ είναι 1,67 και 1.33 αντίστοιχα στο ματς. Το πιο πιθανό σκορ είναι το 1-1 με 11%.', PAYLOAD);
  assert.equal(g.ok, true, g.reason);
});

test('validator: an invented number is rejected, whatever the format', () => {
  for (const bad of [GOOD.replace('46%', '47%'), GOOD.replace('over 2,5', 'over 4,5'), GOOD + ' Η διαφορά είναι 16 μονάδες.', GOOD.replace('κοντά στα 11', 'κοντά στα 10,9')]) {
    const r = ai.validateComment(bad, PAYLOAD);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /^number-not-in-input:/);
  }
});

test('validator: not Greek, lists, titles, markdown, betting talk and certainty are rejected', () => {
  const reason = (t) => ai.validateComment(t, PAYLOAD).reason;
  assert.equal(reason('Alpha 1 are the favourites with 46% to win and over 2.5 goals looks likely, about 58%.'), 'not-greek');
  assert.equal(reason(GOOD.split('. ').map((s) => `- ${s}`).join('.\n')), 'list');
  assert.equal(reason(GOOD.split('. ').map((s, i) => `${i + 1}. ${s}`).join('.\n')), 'list');
  assert.equal(reason(`Ανάλυση αγώνα\n${GOOD}`), 'title');
  assert.equal(reason(`**Φαβορί** η Alpha 1 με 46%. ${GOOD}`), 'markdown');
  assert.match(reason(`${GOOD} Αξίζει ένα στοίχημα στη νίκη.`), /^banned-word/);
  assert.match(reason(`${GOOD} Κανένας τζόγος.`), /^banned-word/);
  assert.match(reason(`${GOOD} Value bet στο over.`), /^banned-word/);
  assert.match(reason('Η Alpha 1 θα κερδίσει σίγουρα με 46% πιθανότητα. Το over 2,5 έχει 58% και το GG 60%.'), /^banned-word/);
  assert.match(reason('Εγγυημένη νίκη για την Alpha 1 με 46%. Το over 2,5 έχει 58% και το GG 60%.'), /^banned-word/);
  assert.equal(reason(''), 'empty');
  assert.equal(reason('Μία μόνο πρόταση χωρίς καμία χρήσιμη πληροφορία για τον αγώνα που ζητήθηκε.'), 'too-few-sentences');
});

test('validator: more than 4 sentences are cut to 4, a cut-off last sentence is dropped', () => {
  const five = `${GOOD} Και ένα ακόμα σχόλιο χωρίς αριθμούς.`;
  const r = ai.validateComment(five, PAYLOAD);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(ai.splitSentences(r.text).sentences.length, 4);
  const cut = ai.validateComment(`${GOOD.split('. ').slice(0, 3).join('. ')}. Οι εκτιμήσεις είναι στατι`, PAYLOAD);
  assert.equal(cut.ok, true);
  assert.ok(cut.text.endsWith('63%.'), cut.text);
  assert.equal(ai.validateComment('Φαβορί η Alpha 1 με 46% έναντι Beta 1 με 30%. Στα γκολ το over 2,5 έχει 58% και τα κόρνε', PAYLOAD).reason, 'cut-off');
});

test('sentence splitter: decimals, abbreviations and the Greek question mark', () => {
  assert.deepEqual(ai.splitSentences('Το over 2,5 είναι 58%. Το xG είναι 1.67. Τέλος.').sentences, ['Το over 2,5 είναι 58%.', 'Το xG είναι 1.67.', 'Τέλος.']);
  assert.deepEqual(ai.splitSentences('Παίζει η St. Pauli εντός. Και ο αντίπαλος.').sentences, ['Παίζει η St. Pauli εντός.', 'Και ο αντίπαλος.']);
  assert.equal(ai.splitSentences('Είναι φαβορί; Ναι; Όχι.').sentences.length, 3);
  assert.equal(ai.splitSentences('Χωρίς τελεία').complete, false);
  assert.equal(ai.splitSentences('Με τελεία.').complete, true);
});

test('numbers: payload values only (keys such as "x12" do not whitelist 12)', () => {
  const nums = ai.payloadNumbers(PAYLOAD);
  assert.ok(nums.has(46) && nums.has(2.5) && nums.has(9.5) && nums.has(1.67));
  assert.ok(!nums.has(12), 'the key "x12" must not allow the number 12');
  assert.deepEqual([...ai.numbersIn('10,4 και 10.40 και 7')].sort((a, b) => a - b), [7, 10.4]);
});

// ---------------------------------------------------------- client policy --

function scripted(outcomes, log = []) {
  // outcomes: per call 'ok' | status number | 'net'
  let i = 0;
  return async ({ model }) => {
    const o = outcomes[Math.min(i++, outcomes.length - 1)];
    log.push({ model, outcome: o });
    if (o === 'ok') return { text: 'x', model, finishReason: 'stop' };
    const err = new Error(o === 'net' ? 'network down' : `HTTP ${o}`);
    if (o !== 'net') err.status = o;
    throw err;
  };
}

test('client: 429 on the primary model moves to the fallback for the rest of the run; 429 there stops', async () => {
  const log = [];
  const slept = [];
  const c = ai.createAiClient({ chat: scripted([429, 'ok', 'ok', 429], log), primary: 'big', fallback: 'small', sleepFn: async (ms) => slept.push(ms) });
  const r1 = await c.ask({ system: 's', user: 'u' });
  assert.equal(r1.status, 'ok');
  assert.deepEqual(log.map((l) => l.model), ['big', 'small']);
  assert.equal((await c.ask({ system: 's', user: 'u' })).status, 'ok');
  assert.deepEqual(log.map((l) => l.model), ['big', 'small', 'small'], 'the primary quota is used up: stay on the fallback');
  const r3 = await c.ask({ system: 's', user: 'u' });
  assert.equal(r3.status, 'stopped');
  assert.match(c.state.stopped, /429/);
  assert.equal((await c.ask({ system: 's', user: 'u' })).status, 'stopped');
  assert.equal(log.length, 4, 'no call after the stop');
  assert.ok(slept.length === 3 && slept.every((ms) => ms >= 6000), `gaps: ${slept}`);
});

test('client: 5xx or network errors try the fallback once; three failures in a row stop; 401 stops at once', async () => {
  const log = [];
  const c = ai.createAiClient({ chat: scripted([500, 'ok'], log), primary: 'big', fallback: 'small', sleepFn: async () => {} });
  assert.equal((await c.ask({})).status, 'ok');
  assert.deepEqual(log.map((l) => l.model), ['big', 'small']);
  assert.equal(c.state.active, 'big', 'a 5xx does not switch models for good');
  assert.equal(c.state.fallbackUsed, true);

  const bad = ai.createAiClient({ chat: scripted(['net']), primary: 'big', fallback: 'small', sleepFn: async () => {} });
  assert.equal((await bad.ask({})).status, 'error');
  assert.equal((await bad.ask({})).status, 'error');
  assert.equal((await bad.ask({})).status, 'stopped');
  assert.match(bad.state.stopped, /errors in a row/);

  const key = ai.createAiClient({ chat: scripted([401]), primary: 'big', fallback: 'small', sleepFn: async () => {} });
  assert.equal((await key.ask({})).status, 'stopped');
  assert.match(key.state.stopped, /key-rejected/);
  assert.equal(key.state.calls, 1);
});

test('client: a retired model (404, or 400 "decommissioned") is not asked again; on the fallback it stops the step', async () => {
  const gone = (status, body = '') => async ({ model }) => {
    const err = new Error(`HTTP ${status} ${body}`);
    err.status = status;
    err.body = body;
    err.model = model;
    throw err;
  };
  for (const [status, body] of [[404, ''], [400, '{"error":{"code":"model_decommissioned"}}'], [400, 'The model has been decommissioned and is no longer supported']]) {
    const log = [];
    const chat = async (a) => {
      log.push(a.model);
      if (a.model === 'big') await gone(status, body)(a);
      return { text: 'x', model: a.model, finishReason: 'stop' };
    };
    const c = ai.createAiClient({ chat, primary: 'big', fallback: 'small', sleepFn: async () => {} });
    assert.equal((await c.ask({})).status, 'ok', `${status} ${body}`);
    assert.equal((await c.ask({})).status, 'ok');
    assert.deepEqual(log, ['big', 'small', 'small'], 'only one wasted call');
    assert.deepEqual(c.state.unavailable, ['big']);
    assert.equal(c.state.active, 'small');
    assert.equal(c.state.consecutiveErrors, 0);
  }
  // an ordinary 400 (bad request) is NOT a retired model: it counts as a normal error
  const bad = ai.createAiClient({ chat: gone(400, 'unsupported value for reasoning_effort'), primary: 'big', fallback: 'small', sleepFn: async () => {} });
  assert.equal((await bad.ask({})).status, 'error');
  assert.deepEqual(bad.state.unavailable, []);
  // the fallback is gone too: stop at once
  const both = ai.createAiClient({ chat: gone(404), primary: 'big', fallback: 'small', sleepFn: async () => {} });
  assert.equal((await both.ask({})).status, 'stopped');
  assert.match(both.state.stopped, /model-unavailable \(small\)/);
  assert.deepEqual(both.state.unavailable, ['big', 'small']);
  assert.equal(both.state.calls, 2);
  // no fallback configured: the first retired model stops the step
  const alone = ai.createAiClient({ chat: gone(404), primary: 'big', fallback: 'big', sleepFn: async () => {} });
  assert.equal((await alone.ask({})).status, 'stopped');
  assert.equal(alone.state.calls, 1);
});

test('client: gpt-oss models are paced at 10 s (8,000 tokens per minute), other models at 6 s', async () => {
  const slept = [];
  const ok = async ({ model }) => ({ text: 'x', model, finishReason: 'stop' });
  const reasoning = ai.createAiClient({ chat: ok, primary: 'openai/gpt-oss-120b', fallback: 'openai/gpt-oss-20b', sleepFn: async (ms) => slept.push(ms) });
  for (let i = 0; i < 3; i++) await reasoning.ask({});
  assert.deepEqual(slept, [10000, 10000], 'no pause before the very first call');
  const plain = [];
  const other = ai.createAiClient({ chat: ok, primary: 'qwen/qwen3.8-27b', fallback: 'x/y', sleepFn: async (ms) => plain.push(ms) });
  for (let i = 0; i < 3; i++) await other.ask({});
  assert.deepEqual(plain, [6000, 6000]);
  assert.ok(ai.AI_LIMITS.minGapMs >= 6000 && ai.AI_LIMITS.minGapMsReasoning >= 10000);
});

test('client: never more than maxCalls HTTP attempts', async () => {
  const c = ai.createAiClient({ chat: scripted([500]), primary: 'big', fallback: 'small', sleepFn: async () => {}, limits: { ...ai.AI_LIMITS, maxCalls: 5, maxConsecutiveErrors: 99 } });
  for (let i = 0; i < 10; i++) await c.ask({});
  assert.equal(c.state.calls, 5);
  assert.equal(c.state.stopped, 'call-limit');
});

// ------------------------------------------------------------- step logic --

function leagueOf(matches, code = 'PL') {
  return { code, name: code, json: { matches } };
}

test('step: only matches kicking off within 36 h are sent; soonest first; texts are validated', async () => {
  const log = [];
  const matches = [
    fakeMatch(1, hoursFromNow(40)), // outside the window
    fakeMatch(2, hoursFromNow(30)),
    fakeMatch(3, hoursFromNow(2)),
    fakeMatch(4, hoursFromNow(-1)), // already started
    fakeMatch(5, hoursFromNow(35.9)),
  ];
  const res = await ai.runAiStep({ leagues: [leagueOf(matches)], now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('ok', log), sleepFn: async () => {}, logger: quiet });
  assert.deepEqual(log.map((l) => JSON.parse(l.user).home), ['Alpha 3', 'Alpha 2', 'Alpha 5']);
  assert.ok(log.every((l) => l.system === PROMPT_2 && l.model === DEFAULT_MODEL));
  assert.deepEqual(matches.map((m) => m.analysis.source), ['template', 'ai', 'ai', 'template', 'ai']);
  assert.equal(res.stats.candidates, 3);
  assert.equal(res.stats.written, 3);
  assert.equal(res.stats.calls, 3);
  assert.equal(Object.keys(res.cache.entries).length, 3);
  assert.ok(Object.values(res.cache.entries).every((e) => e.text && e.model === DEFAULT_MODEL));
});

test('step: a second run with the same numbers costs nothing; changed numbers ask again and replace the entry', async () => {
  const mk = () => [fakeMatch(1, hoursFromNow(5)), fakeMatch(2, hoursFromNow(6))];
  const log = [];
  const first = await ai.runAiStep({ leagues: [leagueOf(mk())], now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('ok', log), sleepFn: async () => {}, logger: quiet });
  assert.equal(log.length, 2);

  const again = mk();
  const second = await ai.runAiStep({ leagues: [leagueOf(again)], prevCache: first.cache, now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('ok', log), sleepFn: async () => {}, logger: quiet });
  assert.equal(log.length, 2, 'no new call');
  assert.equal(second.stats.cached, 2);
  assert.equal(second.stats.calls, 0);
  assert.deepEqual(again.map((m) => m.analysis.source), ['ai', 'ai']);

  const changed = mk();
  changed[0].goals.btts = { yes: 0.7, no: 0.3 };
  const third = await ai.runAiStep({ leagues: [leagueOf(changed)], prevCache: second.cache, now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('ok', log), sleepFn: async () => {}, logger: quiet });
  assert.equal(log.length, 3, 'exactly one new call');
  assert.equal(third.stats.cached, 1);
  assert.equal(Object.keys(third.cache.entries).length, 2, 'the entry of the old numbers is replaced');
  assert.match(changed[0].analysis.text, /70%/);
});

test('step: without GROQ_API_KEY nothing is called but cached comments are still used', async () => {
  const first = await ai.runAiStep({ leagues: [leagueOf([fakeMatch(1, hoursFromNow(5))])], now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat(), sleepFn: async () => {}, logger: quiet });
  const m = [fakeMatch(1, hoursFromNow(5)), fakeMatch(2, hoursFromNow(6))];
  const res = await ai.runAiStep({ leagues: [leagueOf(m)], prevCache: first.cache, now: NOW, env: {}, logger: quiet });
  assert.equal(res.stats.enabled, false);
  assert.match(res.stats.reason, /GROQ_API_KEY/);
  assert.deepEqual(m.map((x) => x.analysis.source), ['ai', 'template']);
});

test('step: rejected replies fall back to the template, at most 2 attempts per set of numbers', async () => {
  const log = [];
  let cache = null;
  for (let run = 1; run <= 3; run++) {
    const m = [fakeMatch(1, hoursFromNow(5))];
    const res = await ai.runAiStep({ leagues: [leagueOf(m)], prevCache: cache, now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('badNumbers', log), sleepFn: async () => {}, logger: quiet });
    cache = res.cache;
    assert.equal(m[0].analysis.source, 'template');
    assert.equal(m[0].analysis.text, 'template text');
    assert.equal(res.stats.rejections['number-not-in-input'], run <= 2 ? 1 : undefined);
  }
  assert.equal(log.length, 2, 'the third run does not ask again');
  assert.equal(Object.values(cache.entries)[0].failed, 2);
});

test('step: a reply cut off by max_tokens is not accepted', async () => {
  const m = [fakeMatch(1, hoursFromNow(5))];
  const res = await ai.runAiStep({ leagues: [leagueOf(m)], now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('cut'), sleepFn: async () => {}, logger: quiet });
  assert.equal(m[0].analysis.source, 'template');
  assert.equal(res.stats.rejected, 1);
});

test('step: at most 40 calls per run (cache hits do not count), the rest keep the template', async () => {
  const log = [];
  const m = Array.from({ length: 55 }, (_, i) => fakeMatch(i, hoursFromNow(1 + i * 0.5)));
  const res = await ai.runAiStep({ leagues: [leagueOf(m)], now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('ok', log), sleepFn: async () => {}, logger: quiet });
  assert.equal(log.length, 40);
  assert.equal(res.stats.written, 40);
  assert.equal(res.stats.stopped, 'call-limit');
  assert.equal(m.filter((x) => x.analysis.source === 'ai').length, 40);
  assert.deepEqual(m.slice(0, 40).map((x) => x.analysis.source).filter((s) => s !== 'ai'), [], 'the soonest 40 are done');
  // next run: the first 40 come from the cache, 15 new calls
  const m2 = Array.from({ length: 55 }, (_, i) => fakeMatch(i, hoursFromNow(1 + i * 0.5)));
  const res2 = await ai.runAiStep({ leagues: [leagueOf(m2)], prevCache: res.cache, now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat('ok', log), sleepFn: async () => {}, logger: quiet });
  assert.equal(res2.stats.cached, 40);
  assert.equal(log.length, 40 + 15);
  assert.ok(m2.every((x) => x.analysis.source === 'ai'));
});

test('step: pauses of at least 6 s between calls', async () => {
  const slept = [];
  const m = [1, 2, 3, 4].map((i) => fakeMatch(i, hoursFromNow(i)));
  await ai.runAiStep({ leagues: [leagueOf(m)], now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat(), sleepFn: async (ms) => slept.push(ms), logger: quiet });
  assert.equal(slept.length, 3);
  assert.ok(slept.every((ms) => ms >= 6000));
});

test('step: prunes entries of finished matches and keeps the ones of later matches', async () => {
  const prev = {
    schema: 1,
    entries: {
      old: { match: 'PL:1', kickoff: hoursFromNow(-30), text: 'παλιό', model: 'm', failed: 0 },
      later: { match: 'PL:2', kickoff: hoursFromNow(60), text: 'μελλοντικό', model: 'm', failed: 0 },
    },
  };
  const res = await ai.runAiStep({ leagues: [leagueOf([fakeMatch(3, hoursFromNow(4))])], prevCache: prev, now: NOW, env: { GROQ_API_KEY: 'k' }, chat: fakeChat(), sleepFn: async () => {}, logger: quiet });
  assert.deepEqual(Object.keys(res.cache.entries).filter((k) => k === 'old' || k === 'later'), ['later']);
});

test('step: a missing prompt file disables the step with a warning', async () => {
  const m = [fakeMatch(1, hoursFromNow(5))];
  const res = await ai.runAiStep({ leagues: [leagueOf(m)], now: NOW, env: { GROQ_API_KEY: 'k', AI_PROMPT_FILE: '/nonexistent/prompt.txt' }, chat: fakeChat(), logger: quiet });
  assert.equal(res.stats.enabled, false);
  assert.equal(res.warnings[0].code, 'ai-no-prompt');
  assert.equal(m[0].analysis.source, 'template');
});

// ----------------------------------------------- the whole refresh pipeline --

async function refresh({ prevDir, env = {}, aiHooks, only = ['PL'] }) {
  const outDir = tmp('out');
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  const res = await runRefresh({
    env: { FOOTBALL_DATA_TOKEN: 'test-token', ...env },
    prevDir: prevDir || tmp('prev'),
    outDir,
    aliasesPath: ALIASES,
    now: NOW,
    logger: { log: push, error: push, warn: push },
    only,
    ai: aiHooks ?? { sleepFn: async () => {} },
  });
  return { outDir, res, log: lines.join('\n') };
}

test('refresh: matches within 36 h get a Groq comment, the others keep the template; the key never leaks', async () => {
  server.groqCalls.length = 0;
  server.set({ groq: 'ok' });
  const run = await refresh({ env: { GROQ_API_KEY: 'groq-test' } });
  assert.equal(run.res.exitCode, 0);
  const pl = readJson(run.outDir, 'PL.json');
  const bySource = Object.fromEntries(pl.matches.map((m) => [m.id, m.analysis.source]));
  assert.equal(bySource[540000], 'ai'); // +4 h
  assert.equal(bySource[540001], 'ai'); // +29.5 h
  assert.equal(pl.matches.filter((m) => m.analysis.source === 'ai').length, 2);
  assert.equal(server.groqCalls.length, 2);
  for (const c of server.groqCalls) {
    assert.equal(c.system, PROMPT_2);
    assert.equal(c.model, DEFAULT_MODEL);
    const payload = JSON.parse(c.user);
    assert.ok(Array.isArray(payload.flags));
    assert.ok(ai.estimateTokens(c.user) <= 350);
  }
  const first = pl.matches.find((m) => m.id === 540000);
  assert.equal(first.analysis.model, DEFAULT_MODEL);
  assert.match(first.analysis.text, /^Φαβορί/);
  // numbers in the text are the model's own
  const sent = JSON.parse(server.groqCalls[0].user);
  const g = first.goals.oneX2;
  assert.deepEqual([sent.x12.home, sent.x12.draw, sent.x12.away], largestRemainder([g.home, g.draw, g.away]));
  assert.match(first.analysis.text, new RegExp(`${sent.x12.home}%`));

  const index = readJson(run.outDir, 'index.json');
  assert.equal(index.phase, 3);
  assert.equal(index.ai.enabled, true);
  assert.equal(index.ai.calls, 2);
  assert.equal(index.ai.written, 2);
  const cache = readJson(run.outDir, 'ai-cache.json');
  assert.equal(Object.keys(cache.entries).length, 2);

  // the secret is nowhere: not in any file, not in the log
  const all = fs.readdirSync(run.outDir, { recursive: true }).map((f) => path.join(run.outDir, f)).filter((f) => fs.statSync(f).isFile());
  for (const f of all) assert.ok(!fs.readFileSync(f).toString('latin1').includes('groq-test'), f);
  assert.ok(!run.log.includes('groq-test'));
  state.first = run;
});

test('refresh: the next run reuses the cache (no Groq call) and keeps tune.json / report.json', async () => {
  const prev = state.first.outDir;
  fs.writeFileSync(path.join(prev, 'report.json'), JSON.stringify({ schema: 1, generatedAt: '2026-10-12T03:00:00Z', leagues: {} }));
  server.groqCalls.length = 0;
  const run = await refresh({ prevDir: prev, env: { GROQ_API_KEY: 'groq-test' } });
  assert.equal(server.groqCalls.length, 0, 'same numbers: everything comes from ai-cache.json');
  const pl = readJson(run.outDir, 'PL.json');
  const before = readJson(prev, 'PL.json');
  assert.deepEqual(pl.matches.filter((m) => m.analysis.source === 'ai').map((m) => m.analysis.text), before.matches.filter((m) => m.analysis.source === 'ai').map((m) => m.analysis.text));
  assert.equal(readJson(run.outDir, 'index.json').ai.cached, 2);
  assert.equal(readJson(run.outDir, 'report.json').generatedAt, '2026-10-12T03:00:00Z', 'report.json travels with the new commit');
});

test('refresh: 429 everywhere -> the step stops, templates stay, a warning is listed', async () => {
  server.groqCalls.length = 0;
  server.set({ groq: '429' });
  const run = await refresh({ env: { GROQ_API_KEY: 'groq-test' } });
  server.set({ groq: 'ok' });
  assert.equal(run.res.exitCode, 0);
  assert.equal(server.groqCalls.length, 2, 'primary 429, fallback 429, then stop');
  assert.deepEqual(server.groqCalls.map((c) => c.model), [DEFAULT_MODEL, FALLBACK_MODEL]);
  const pl = readJson(run.outDir, 'PL.json');
  assert.ok(pl.matches.every((m) => m.analysis.source === 'template'));
  const index = readJson(run.outDir, 'index.json');
  assert.match(index.ai.stopped, /429/);
  assert.ok(index.warnings.some((w) => w.code === 'ai-stopped'));
});

test('refresh: only the primary model is rate limited -> the fallback model writes the comments', async () => {
  server.groqCalls.length = 0;
  server.set({ groq: 'primary429' });
  const run = await refresh({ env: { GROQ_API_KEY: 'groq-test' } });
  server.set({ groq: 'ok' });
  assert.deepEqual(server.groqCalls.map((c) => c.model), [DEFAULT_MODEL, FALLBACK_MODEL, FALLBACK_MODEL]);
  const pl = readJson(run.outDir, 'PL.json');
  assert.deepEqual([...new Set(pl.matches.filter((m) => m.analysis.source === 'ai').map((m) => m.analysis.model))], [FALLBACK_MODEL]);
  assert.equal(readJson(run.outDir, 'index.json').ai.fallbackUsed, true);
});

test('refresh: replies with invented numbers or English are discarded, the page still gets the template', async () => {
  for (const mode of ['badNumbers', 'english', 'betting']) {
    server.groqCalls.length = 0;
    server.set({ groq: mode });
    const run = await refresh({ env: { GROQ_API_KEY: 'groq-test' } });
    const pl = readJson(run.outDir, 'PL.json');
    assert.ok(pl.matches.every((m) => m.analysis.source === 'template'), mode);
    assert.ok(pl.matches.every((m) => m.analysis.text.length > 50 && /Νίκη/.test(m.analysis.text)), mode);
    assert.equal(readJson(run.outDir, 'index.json').ai.rejected, 2, mode);
  }
  server.set({ groq: 'ok' });
});

test('refresh: GROQ_MODEL selects the primary model', async () => {
  server.groqCalls.length = 0;
  const run = await refresh({ env: { GROQ_API_KEY: 'groq-test', GROQ_MODEL: 'qwen/qwen3.8-27b' } });
  assert.deepEqual(new Set(server.groqCalls.map((c) => c.model)), new Set(['qwen/qwen3.8-27b']));
  assert.ok(server.groqCalls.every((c) => c.max_completion_tokens === 220 && c.reasoning_effort === undefined));
  assert.equal(readJson(run.outDir, 'index.json').ai.model, 'qwen/qwen3.8-27b');
});

test('refresh: an empty GROQ_MODEL (unset repository variable) means the default model', async () => {
  server.groqCalls.length = 0;
  const run = await refresh({ env: { GROQ_API_KEY: 'groq-test', GROQ_MODEL: '' } });
  assert.deepEqual(new Set(server.groqCalls.map((c) => c.model)), new Set([DEFAULT_MODEL]));
  assert.equal(readJson(run.outDir, 'index.json').ai.model, DEFAULT_MODEL);
});

test('refresh: the first-choice model has been retired (HTTP 404) -> one wasted call, then the fallback writes everything', async () => {
  for (const mode of ['primaryGone', 'primaryDecommissioned']) {
    server.groqCalls.length = 0;
    server.set({ groq: mode });
    const run = await refresh({ env: { GROQ_API_KEY: 'groq-test' } });
    server.set({ groq: 'ok' });
    assert.deepEqual(server.groqCalls.map((c) => c.model), [DEFAULT_MODEL, FALLBACK_MODEL, FALLBACK_MODEL], mode);
    const pl = readJson(run.outDir, 'PL.json');
    assert.equal(pl.matches.filter((m) => m.analysis.source === 'ai').length, 2, mode);
    assert.ok(pl.matches.filter((m) => m.analysis.source === 'ai').every((m) => m.analysis.model === FALLBACK_MODEL), mode);
    const index = readJson(run.outDir, 'index.json');
    assert.deepEqual(index.ai.unavailable, [DEFAULT_MODEL], mode);
    assert.equal(index.ai.stopped, null, mode);
    const warning = index.warnings.find((w) => w.code === 'ai-model-gone');
    assert.ok(warning && warning.message.includes(DEFAULT_MODEL) && /GROQ_MODEL/.test(warning.message), mode);
  }
});

test('refresh: both models retired -> the step stops after two calls, templates stay, the warning names the models', async () => {
  server.groqCalls.length = 0;
  server.set({ groq: 'bothGone' });
  const run = await refresh({ env: { GROQ_API_KEY: 'groq-test' } });
  server.set({ groq: 'ok' });
  assert.equal(run.res.exitCode, 0);
  assert.deepEqual(server.groqCalls.map((c) => c.model), [DEFAULT_MODEL, FALLBACK_MODEL]);
  assert.ok(readJson(run.outDir, 'PL.json').matches.every((m) => m.analysis.source === 'template'));
  const index = readJson(run.outDir, 'index.json');
  assert.match(index.ai.stopped, /model-unavailable/);
  assert.deepEqual(index.ai.unavailable, [DEFAULT_MODEL, FALLBACK_MODEL]);
  assert.ok(index.warnings.some((w) => w.code === 'ai-model-gone'));
});
