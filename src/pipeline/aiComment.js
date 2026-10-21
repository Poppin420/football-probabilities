// The Greek match comment (Phase 2).
//
// The maths uses zero LLM tokens. The language model only PHRASES a short Greek
// comment from numbers the statistical model has already computed:
//   1. a compact JSON (integer percentages, <= 350 tokens) goes to Groq with
//      the system prompt prompts/ai-comment.system.txt, sent unchanged;
//   2. the reply is checked: if it contains a number that is not in the input
//      JSON (or is not Greek, or has lists / titles / betting words), it is
//      thrown away and the deterministic Greek template stays;
//   3. valid replies are cached (ai-cache.json in branch "data") by
//      sha1(prompt + match id + the rounded numbers), so an unchanged match
//      costs nothing on the next run.
// Limits: only matches that kick off within 36 h, at most 40 Groq calls per
// run, at least 6 s between calls (10 s for the gpt-oss models); a 429 on the
// fallback model stops the step; a model that Groq has retired is replaced by the other one.

import crypto from 'node:crypto';
import { largestRemainder, pct } from '../../public/format.js';
import { sleep } from '../sources/http.js';
import { DEFAULT_PROMPT_FILE, FALLBACK_MODEL, chatComplete, isReasoningModel, loadSystemPrompt, modelFromEnv } from '../sources/groq.js';

export const AI_LIMITS = Object.freeze({
  windowHours: 36, // only matches kicking off within this many hours get a (new) comment
  maxCalls: 40, // Groq calls per run (every HTTP attempt counts)
  minGapMs: 6000, // pause between two calls (free-tier tokens-per-minute limit)
  minGapMsReasoning: 10000, // the gpt-oss models need more tokens per call and have a 8,000 tokens-per-minute limit
  maxFailedAttempts: 2, // rejected replies per key before the template is accepted
  maxConsecutiveErrors: 3, // circuit breaker for 5xx / network errors
  maxTokens: 350, // size of the JSON sent to the model (estimate)
  keepHours: 12, // cache entries are kept until this long after kickoff
});

const GOALS_LINE = 2.5;
const CORNERS_LINE = 9.5;
const CARDS_LINE = 3.5;
const MAX_SENTENCES = 4;

// ---------------------------------------------------------------- payload --

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const lineOf = (markets, line) => markets?.find((t) => Math.abs(t.line - line) < 1e-9) ?? null;

/** Rough, deliberately pessimistic token estimate (Greek costs ~2 tokens per word piece). */
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other / 1.6);
}

/** Data-quality remarks for the "flags" field, most important first (Greek, plain words). */
export function flagsOf(match) {
  const f = match.flags || {};
  const names = (a, b) => [a ? match.homeName : null, b ? match.awayName : null].filter(Boolean).join(' και ');
  const out = [];
  if (f.eloOnly) out.push('μοντέλο μόνο με βαθμολογία Elo, χωρίς φόρμα ή απουσίες: χαμηλότερη βεβαιότητα');
  if (f.promotedHome || f.promotedAway) out.push(`νεοφώτιστη ομάδα (${names(f.promotedHome, f.promotedAway)}): λίγα δεδομένα στη λίγκα`);
  else if (f.fewDataHome || f.fewDataAway) out.push(`λίγα δεδομένα για: ${names(f.fewDataHome, f.fewDataAway)}`);
  if (f.lowConfidence) out.push('χαμηλή βεβαιότητα του μοντέλου');
  if (match.scorers) out.push('οι σκόρερ υπολογίστηκαν χωρίς γνωστές συνθέσεις, τραυματισμούς ή ποινές');
  return out;
}

/**
 * Compact input for the language model: rounded integer percentages, a few
 * one- or two-decimal averages, the market lines spelled out, and "flags".
 * Optional parts are dropped (scorers first) until the estimate fits the budget.
 * Returns { payload, json, tokens, dropped }.
 */
export function buildPayload(match, { maxTokens = AI_LIMITS.maxTokens } = {}) {
  const g = match.goals;
  const [ph, pd, pa] = largestRemainder([g.oneX2.home, g.oneX2.draw, g.oneX2.away]);
  const o25 = lineOf(g.totals, GOALS_LINE);
  const [over, under] = largestRemainder([o25.over, o25.under]);
  const base = {
    home: match.homeName,
    away: match.awayName,
    x12: { home: ph, draw: pd, away: pa },
    ou: { line: GOALS_LINE, over, under },
    btts: pct(g.btts.yes),
    scores: g.correctScores.slice(0, 3).map((c) => ({ s: c.score, p: pct(c.p) })),
    exp_goals: { home: round(g.expected.home, 2), away: round(g.expected.away, 2) },
  };
  const optional = {};
  const co = match.corners && lineOf(match.corners.totals, CORNERS_LINE);
  if (co) optional.corners = { avg: round(match.corners.mean.total, 1), line: CORNERS_LINE, over: pct(co.over) };
  const ca = match.cards && lineOf(match.cards.totals, CARDS_LINE);
  if (ca) optional.cards = { avg: round(match.cards.mean.total, 1), line: CARDS_LINE, over: pct(ca.over) };
  if (match.scorers) {
    const top = [
      ...(match.scorers.home || []).map((p) => ({ n: p.name, t: match.homeName, p: pct(p.anytime) })),
      ...(match.scorers.away || []).map((p) => ({ n: p.name, t: match.awayName, p: pct(p.anytime) })),
    ]
      .sort((a, b) => b.p - a.p)
      .slice(0, 3);
    if (top.length > 0) optional.scorers = top;
  }

  const assemble = (opt, scores) => ({ ...base, scores, ...opt, flags: flagsOf(match) });
  const dropped = [];
  let scores = base.scores;
  let opt = { ...optional };
  let payload = assemble(opt, scores);
  let json = JSON.stringify(payload);
  for (const step of ['scorers', 'cards', 'corners', 'scores']) {
    if (estimateTokens(json) <= maxTokens) break;
    if (step === 'scores') scores = scores.slice(0, 1);
    else delete opt[step];
    dropped.push(step);
    payload = assemble(opt, scores);
    json = JSON.stringify(payload);
  }
  return { payload, json, tokens: estimateTokens(json), dropped };
}

/** Cache key: sha1 of the prompt version, the match id and the rounded numbers. */
export function cacheKey({ promptHash, league, matchId, json }) {
  return crypto.createHash('sha1').update(`${promptHash}|${league}|${matchId}|${json}`).digest('hex');
}

// ------------------------------------------------------------- validation --

const NUM_RE = /\d+(?:[.,]\d+)?/g;

/** Set of numeric values in a text ("10,4" and "10.4" are the same number). */
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(NUM_RE)) out.add(Number(m[0].replace(',', '.')));
  return out;
}

/** Numbers that appear as VALUES in the payload (keys are not counted). */
export function payloadNumbers(value, set = new Set()) {
  if (typeof value === 'number') set.add(value);
  else if (typeof value === 'string') for (const n of numbersIn(value)) set.add(n);
  else if (Array.isArray(value)) for (const v of value) payloadNumbers(v, set);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) payloadNumbers(v, set);
  return set;
}

/** Lower case, no accents, final sigma folded: for accent-insensitive word checks. */
export function foldGreek(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ');
}

// Betting talk and certainty are forbidden by the prompt (rule 3).
// Written in the folded form of foldGreek(): no accents, lower case, final sigma = σ.
const BANNED_FOLDED = [
  'στοιχημ', // στοίχημα, στοιχηματίστε
  'τζογ', // τζόγος
  'πονταρ', // ποντάρετε
  'σιγουρ', // σίγουρα, σίγουρη νίκη
  'εγγυημεν', // εγγυημένη
  'αδιαμφισβητ',
  'οπωσδηποτε',
  'χωρισ αμφιβολια',
  'θα κερδισ', // θα κερδίσει = a definite prediction
  'θα νικησ',
];
const BANNED_LATIN = /\b(?:odds?|bets?|betting|bookmakers?|bookies?|wager|stake|tips?)\b/i;

const ABBREVIATIONS = new Set(['st', 'dr', 'mr', 'sr', 'jr', 'mt', 'ath', 'utd', 'man', 'sp', 'fc', 'afc']);
const TERMINATORS = '.!?;\u2026\u037e'; // . ! ? ; … and the Greek question mark U+037E

/**
 * Split a paragraph into sentences. Returns { sentences, complete } where
 * complete = the last sentence ends with a terminator (the text is not cut off).
 */
export function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!TERMINATORS.includes(text[i])) continue;
    let j = i;
    while (j + 1 < text.length && TERMINATORS.includes(text[j + 1])) j++;
    const next = text[j + 1];
    const decimalPoint = text[i] === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(next || '');
    let abbreviation = false;
    if (text[i] === '.') {
      const word = /([A-Za-z]+)$/.exec(text.slice(start, i));
      abbreviation = Boolean(word && ABBREVIATIONS.has(word[1].toLowerCase()));
    }
    if (!decimalPoint && !abbreviation && (next === undefined || /\s/.test(next))) {
      out.push(text.slice(start, j + 1).trim());
      start = j + 1;
    }
    i = j;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  const last = out.at(-1) || '';
  return { sentences: out, complete: last !== '' && TERMINATORS.includes(last.at(-1)) };
}

/**
 * Check one model reply against the input it was written from.
 * Returns { ok: true, text, truncated } or { ok: false, reason }.
 */
export function validateComment(raw, payload, { maxSentences = MAX_SENTENCES } = {}) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  let text = raw.replace(/\r\n?/g, '\n').trim();
  if (/^["“«].*["”»]$/s.test(text)) text = text.slice(1, -1).trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length > 1200) return { ok: false, reason: 'too-long' };

  if (/[*_`#|]{2,}|```|^\s*#/m.test(text) || /\*\*|__|`/.test(text)) return { ok: false, reason: 'markdown' };
  if (/^\s*(?:[-*•–—]|\d+[.)])\s+\S/m.test(text)) return { ok: false, reason: 'list' };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines[0].length < 60 && !TERMINATORS.includes(lines[0].at(-1))) return { ok: false, reason: 'title' };
  text = lines.join(' ');

  const folded = foldGreek(text);
  const word = BANNED_FOLDED.find((w) => folded.includes(w));
  if (word) return { ok: false, reason: `banned-word:${word}` };
  if (BANNED_LATIN.test(text)) return { ok: false, reason: 'banned-word:latin' };

  const allowed = payloadNumbers(payload);
  const withoutMarket = text.replace(/\b1\s*[xXχΧ]\s*2\b/g, ' ');
  for (const n of numbersIn(withoutMarket)) {
    if (![...allowed].some((a) => Math.abs(a - n) < 1e-9)) return { ok: false, reason: `number-not-in-input:${n}` };
  }

  const greek = (text.match(/[\u0370-\u03ff\u1f00-\u1fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (greek < 30 || greek / (greek + latin) < 0.6) return { ok: false, reason: 'not-greek' };

  let { sentences, complete } = splitSentences(text);
  if (!complete) {
    sentences = sentences.slice(0, -1); // a cut-off last sentence is dropped, never completed
    if (sentences.length < 2) return { ok: false, reason: 'cut-off' };
  }
  if (sentences.length < 2) return { ok: false, reason: 'too-few-sentences' };
  const truncated = sentences.length > maxSentences;
  if (truncated) sentences = sentences.slice(0, maxSentences);
  return { ok: true, text: sentences.join(' '), truncated };
}

// ----------------------------------------------------------- Groq client --

const MODEL_GONE = /decommission|model_not_found|no longer supported|does not exist|not found/i;

/** Groq answers 404 (or 400 "decommissioned") for a model it has retired or never had. */
export function isModelGone(err) {
  const status = Number(err?.status) || 0;
  if (status === 404) return true;
  return status === 400 && MODEL_GONE.test(`${err?.body ?? ''} ${err?.message ?? ''}`);
}

/**
 * Model policy on top of a `chat({ model, system, user })` function:
 *  - 429 on the primary model: continue on the fallback model for the rest of
 *    the run (the limits are per model); 429 on the fallback model: STOP;
 *  - model retired / unknown (404, 400 "decommissioned"): same as 429 for the
 *    primary model (the rest of the run uses the fallback, and the model is
 *    listed in state.unavailable); on the fallback model: STOP;
 *  - 5xx / network / unexpected answer on the primary model: try the fallback
 *    once for this match; 3 failures in a row stop the step (circuit breaker);
 *  - 401 / 403: the key is rejected, STOP.
 * Every HTTP attempt counts as one call against maxCalls.
 */
export function createAiClient({ chat, primary, fallback = FALLBACK_MODEL, sleepFn = sleep, limits = AI_LIMITS }) {
  const state = {
    active: primary,
    calls: 0,
    stopped: null, // stop reason, or null
    consecutiveErrors: 0,
    byModel: {},
    fallbackUsed: false,
    unavailable: [], // models that Groq reported as retired / unknown during this run
  };
  const hasFallback = Boolean(fallback) && fallback !== primary;
  const gapFor = (model) => (isReasoningModel(model) ? Math.max(limits.minGapMs, limits.minGapMsReasoning ?? 0) : limits.minGapMs);
  let firstCall = true;

  const stop = (reason) => {
    state.stopped = reason;
    return { status: 'stopped', reason };
  };

  async function ask({ system, user }) {
    if (state.stopped) return { status: 'stopped', reason: state.stopped };
    const order = [state.active];
    if (hasFallback && state.active === primary) order.push(fallback);
    let lastError = null;
    for (const model of order) {
      if (state.calls >= limits.maxCalls) return stop('call-limit');
      if (!firstCall) await sleepFn(gapFor(model));
      firstCall = false;
      state.calls++;
      state.byModel[model] = (state.byModel[model] || 0) + 1;
      try {
        const res = await chat({ model, system, user });
        state.consecutiveErrors = 0;
        if (model !== primary) state.fallbackUsed = true;
        return { status: 'ok', text: res.text, model: res.model || model, finishReason: res.finishReason ?? null };
      } catch (err) {
        const status = Number(err?.status) || 0;
        lastError = status ? `HTTP ${status}` : String(err?.message || err).slice(0, 120);
        if (status === 401 || status === 403) return stop(`key-rejected (HTTP ${status})`);
        if (isModelGone(err)) {
          if (!state.unavailable.includes(model)) state.unavailable.push(model);
          if (!hasFallback || model === fallback) return stop(`model-unavailable (${model})`);
          state.active = fallback; // do not ask the retired model again during this run
          continue;
        }
        if (status === 429) {
          if (!hasFallback || model === fallback) return stop('rate-limited (HTTP 429)');
          state.active = fallback; // the primary model's quota is used up: stay on the fallback
        }
      }
    }
    state.consecutiveErrors++;
    if (state.consecutiveErrors >= limits.maxConsecutiveErrors) return stop(`errors in a row (${lastError})`);
    return { status: 'error', reason: lastError };
  }

  return { ask, state };
}

// ---------------------------------------------------------- orchestration --

function isEntry(e) {
  return e && typeof e === 'object' && typeof e.match === 'string' && typeof e.kickoff === 'string';
}

/**
 * Add Greek comments to the matches of the (in-memory) league JSONs.
 *
 * @param {{code:string, name:string, json:object}[]} p.leagues
 * @param {object|null} p.prevCache   previous ai-cache.json (or null)
 * @returns {{ cache: object, stats: object, warnings: object[] }}
 *          cache = the new ai-cache.json content; stats go to index.json "ai".
 */
export async function runAiStep({
  leagues,
  prevCache = null,
  now,
  env = process.env,
  prompt = undefined,
  chat = undefined,
  sleepFn = sleep,
  logger = console,
  limits = {},
}) {
  const L = { ...AI_LIMITS, ...limits };
  const warnings = [];
  const stats = {
    enabled: false,
    reason: null,
    model: null,
    candidates: 0,
    cached: 0,
    calls: 0,
    written: 0,
    rejected: 0,
    errors: 0,
    skipped: 0,
    stopped: null,
    fallbackUsed: false,
    unavailable: [],
    models: {},
    rejections: {},
  };

  const promptInfo = prompt === undefined ? loadSystemPrompt(env.AI_PROMPT_FILE || DEFAULT_PROMPT_FILE) : prompt;
  const emptyCache = { schema: 1, promptHash: promptInfo?.hash ?? null, generatedAt: now.toISOString(), entries: {} };
  if (!promptInfo) {
    stats.reason = 'prompt file missing or empty';
    warnings.push({ code: 'ai-no-prompt', message: 'Σχόλιο AI: λείπει το prompts/ai-comment.system.txt - χρησιμοποιείται το αυτόματο κείμενο.' });
    return { cache: emptyCache, stats, warnings };
  }

  // Previous cache entries that still matter (match not long finished).
  const keepFrom = now.getTime() - L.keepHours * 3600e3;
  const prevEntries = prevCache?.schema === 1 && prevCache.entries && typeof prevCache.entries === 'object' ? prevCache.entries : {};
  const entries = {};
  for (const [k, e] of Object.entries(prevEntries)) {
    if (isEntry(e) && Date.parse(e.kickoff) >= keepFrom) entries[k] = e;
  }

  // Groq availability.
  const key = env.GROQ_API_KEY;
  const primary = modelFromEnv(env);
  const send = chat || (key ? ({ model, system, user }) => chatComplete({ key, model, system, user }) : null);
  if (!send) {
    stats.reason = 'GROQ_API_KEY is not set (only cached comments are used)';
  } else {
    stats.enabled = true;
    stats.model = primary;
  }
  const client = send ? createAiClient({ chat: send, primary, sleepFn, limits: L }) : null;

  // All matches, soonest first.
  const flat = [];
  for (const lg of leagues) {
    for (const m of lg.json.matches || []) flat.push({ code: lg.code, m });
  }
  flat.sort((a, b) => a.m.kickoff.localeCompare(b.m.kickoff) || a.m.id - b.m.id);

  const windowEnd = now.getTime() + L.windowHours * 3600e3;
  const sinceCache = Object.fromEntries(Object.entries(entries).map(([k, e]) => [e.match, k])); // match -> key
  const reject = (reason) => {
    const short = reason.split(':')[0];
    stats.rejected++;
    stats.rejections[short] = (stats.rejections[short] || 0) + 1;
  };

  for (const { code, m } of flat) {
    const kickoffMs = Date.parse(m.kickoff);
    const { payload, json } = buildPayload(m);
    const k = cacheKey({ promptHash: promptInfo.hash, league: code, matchId: m.id, json });
    const matchId = `${code}:${m.id}`;
    const hit = entries[k];
    const inWindow = Number.isFinite(kickoffMs) && kickoffMs >= now.getTime() && kickoffMs <= windowEnd;
    if (inWindow) stats.candidates++;

    if (hit?.text) {
      m.analysis = { text: hit.text, source: 'ai', model: hit.model || null };
      stats.cached++;
      const older = sinceCache[matchId];
      if (older && older !== k) delete entries[older]; // numbers moved back to an earlier text
      sinceCache[matchId] = k;
      continue;
    }
    if (!inWindow || !client) continue;
    if ((hit?.failed ?? 0) >= L.maxFailedAttempts) {
      stats.skipped++;
      continue;
    }
    if (client.state.stopped) {
      stats.skipped++;
      continue;
    }

    const res = await client.ask({ system: promptInfo.text, user: json });
    if (res.status === 'stopped') {
      stats.skipped++;
      continue;
    }
    if (res.status === 'error') {
      stats.errors++;
      continue;
    }

    const checked = validateComment(res.text, payload);
    // A new answer for the same match replaces the older entry (numbers changed since).
    const old = sinceCache[matchId];
    if (old && old !== k) delete entries[old];
    if (checked.ok && res.finishReason !== 'length') {
      entries[k] = { match: matchId, kickoff: m.kickoff, text: checked.text, model: res.model, at: now.toISOString(), failed: 0 };
      m.analysis = { text: checked.text, source: 'ai', model: res.model };
      sinceCache[matchId] = k;
      stats.written++;
    } else {
      const reason = checked.ok ? 'cut-off (max_tokens reached)' : checked.reason;
      reject(reason);
      entries[k] = { match: matchId, kickoff: m.kickoff, failed: (hit?.failed ?? 0) + 1, lastReason: reason, model: res.model, at: now.toISOString() };
      sinceCache[matchId] = k;
      logger.log(`[AI] ${matchId}: reply rejected (${reason}); the Greek template is used.`);
    }
  }

  if (client) {
    stats.calls = client.state.calls;
    stats.stopped = client.state.stopped;
    stats.fallbackUsed = client.state.fallbackUsed;
    stats.unavailable = client.state.unavailable;
    stats.models = client.state.byModel;
    if (client.state.unavailable.length > 0) {
      warnings.push({
        code: 'ai-model-gone',
        message: `Σχόλιο AI: το μοντέλο ${client.state.unavailable.join(', ')} δεν είναι πια διαθέσιμο στο Groq. Όρισε άλλο στη μεταβλητή GROQ_MODEL (οδηγίες στο SETUP.md).`,
      });
    }
    if (client.state.stopped && client.state.stopped !== 'call-limit') {
      warnings.push({
        code: 'ai-stopped',
        message: `Σχόλιο AI: το βήμα σταμάτησε (${client.state.stopped}). Οι υπόλοιποι αγώνες έχουν το αυτόματο κείμενο.`,
      });
    }
  }
  if (stats.rejected > 0 && stats.written === 0 && stats.cached === 0) {
    warnings.push({ code: 'ai-all-rejected', message: `Σχόλιο AI: και οι ${stats.rejected} απαντήσεις απορρίφθηκαν από τον έλεγχο (${Object.keys(stats.rejections).join(', ')}).` });
  }
  return { cache: { schema: 1, promptHash: promptInfo.hash, generatedAt: now.toISOString(), entries }, stats, warnings };
}
