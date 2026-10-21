// Groq (OpenAI-compatible API).
//   - listModels: checks that the key works (no tokens are consumed).
//   - chatComplete: one chat completion. Used ONLY to phrase the Greek match
//     comment from numbers the statistical model already computed; the maths
//     never touches an LLM.
// The key travels only in the Authorization header and is never logged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASES } from '../config.js';
import { HttpError, httpGet, httpRequest } from './http.js';

// Groq shut down llama-3.3-70b-versatile and llama-3.1-8b-instant on 16 Aug 2026 (they were the first
// choice of this project) and names openai/gpt-oss-120b / -20b as the production replacements
// (https://console.groq.com/docs/deprecations). Models come and go: the repository variable GROQ_MODEL
// overrides the first choice, and a model that has been retired is replaced by the other one at run time.
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const FALLBACK_MODEL = 'openai/gpt-oss-20b';
export const MAX_TOKENS = 220; // room for the visible comment (a few short Greek sentences)
export const REASONING_ALLOWANCE = 400; // extra room for models that "think" first: their thinking counts in the same limit
export const TEMPERATURE = 0.3;

/** gpt-oss models write a short chain of thought before the answer; the answer itself is message.content. */
export function isReasoningModel(model) {
  return /^openai\/gpt-oss/i.test(String(model || ''));
}

/** Request fields that depend on the model: the token limit and the (lowest) thinking effort. */
export function modelSettings(model) {
  if (isReasoningModel(model)) {
    return { maxTokens: MAX_TOKENS + REASONING_ALLOWANCE, extra: { reasoning_effort: 'low', include_reasoning: false } };
  }
  return { maxTokens: MAX_TOKENS, extra: {} };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROMPT_FILE = path.resolve(here, '../../prompts/ai-comment.system.txt');

export function modelFromEnv(env = process.env) {
  return env.GROQ_MODEL || DEFAULT_MODEL;
}

/**
 * The system prompt, exactly as stored in prompts/ai-comment.system.txt:
 * only the line endings are normalised (CRLF -> LF) and ONE final newline is
 * removed. Returns { text, hash } or null when the file is missing or empty.
 */
export function loadSystemPrompt(file = process.env.AI_PROMPT_FILE || DEFAULT_PROMPT_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.trim() === '') return null;
  return { text, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 10), file };
}

/** GET /models; returns { ok, models[] } (ids of the models that are active) and never includes the key. */
export async function listModels({ key, baseUrl = BASES.groq, fetchImpl }) {
  if (!key) return { ok: false, reason: 'GROQ_API_KEY is not set', models: [] };
  const res = await httpGet(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${key}` },
    as: 'json',
    retries: 1,
    fetchImpl,
  });
  const data = Array.isArray(res.body?.data) ? res.body.data : [];
  const models = data.filter((m) => m && m.id && m.active !== false).map((m) => m.id);
  return { ok: models.length > 0, reason: models.length ? 'key accepted' : 'no models in response', models };
}

/**
 * One chat completion: system prompt + one user message (the compact JSON).
 * No retry and no waiting on HTTP 429 here: the caller decides what a rate
 * limit means (switch model, stop the AI step).
 * Returns { text, model, finishReason, usage }. Throws HttpError (with .status)
 * or Error('Groq: ...') when the answer has an unexpected shape.
 */
export async function chatComplete({
  key,
  model,
  system,
  user,
  baseUrl = BASES.groq,
  maxTokens, // default: modelSettings(model).maxTokens
  temperature = TEMPERATURE,
  timeoutMs = 45000,
  fetchImpl,
}) {
  if (!key) throw new Error('Groq: GROQ_API_KEY is not set');
  const settings = modelSettings(model);
  const res = await httpRequest(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    json: {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_completion_tokens: maxTokens ?? settings.maxTokens, // "max_tokens" is the deprecated name of the same limit
      ...settings.extra,
    },
    as: 'json',
    retries: 0,
    max429Waits: 0,
    timeoutMs,
    fetchImpl,
  });
  const choice = res.body?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string') throw new Error('Groq: unexpected response shape (no choices[0].message.content)');
  return {
    text,
    model: typeof res.body.model === 'string' ? res.body.model : model,
    finishReason: choice.finish_reason ?? null,
    usage: res.body.usage ?? null,
  };
}

export { HttpError };
