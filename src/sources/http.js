// Minimal HTTP helper: timeouts, retries, 429 / Retry-After handling.
// Secrets travel only in request headers and are never logged or echoed:
// error messages contain the URL and a short body excerpt, nothing else.

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', retryAfterMs = null, body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * HTTP request with retries (GET by default; POST with a JSON body via `json`).
 * as: 'text' | 'json' | 'buffer'
 * Returns { status, headers, body }.
 * A POST is retried like a GET: callers that must not repeat a request
 * (a paid API call, say) pass retries: 0 and max429Waits: 0.
 */
export async function httpRequest(url, opts = {}) {
  const {
    method = 'GET',
    json,
    headers = {},
    timeoutMs = 30000,
    retries = 2,
    as = 'text',
    max429Waits = 3,
    maxRetryAfterMs = 150000,
    backoffMs = Number(process.env.HTTP_BACKOFF_MS ?? 2000),
    sleepFn = sleep,
    fetchImpl = globalThis.fetch,
  } = opts;
  const href = String(url);
  let attempt = 0;
  let waits429 = 0;

  for (;;) {
    let res;
    try {
      const init = {
        headers: { 'user-agent': 'football-probabilities/0.1 (+github actions)', ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (method !== 'GET') init.method = method;
      if (json !== undefined) init.body = JSON.stringify(json);
      res = await fetchImpl(href, init);
    } catch (err) {
      if (attempt < retries) {
        attempt++;
        await sleepFn(backoffMs * attempt);
        continue;
      }
      throw new HttpError(`Network error for ${href}: ${err.cause?.code || err.name || 'unknown'}`, { url: href });
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (waits429 < max429Waits && (retryAfterMs ?? 65000) <= maxRetryAfterMs) {
        waits429++;
        await sleepFn((retryAfterMs ?? 65000) + 500);
        continue;
      }
      throw new HttpError(`HTTP 429 (rate limited) for ${href}`, { status: 429, url: href, retryAfterMs });
    }

    if (res.status >= 500 && attempt < retries) {
      attempt++;
      await sleepFn(backoffMs * attempt);
      continue;
    }

    if (!res.ok) {
      let excerpt = '';
      try {
        excerpt = (await res.text()).slice(0, 300);
      } catch {
        // ignore
      }
      throw new HttpError(`HTTP ${res.status} for ${href}${excerpt ? `: ${excerpt.replace(/\s+/g, ' ')}` : ''}`, {
        status: res.status,
        url: href,
        body: excerpt,
      });
    }

    let body;
    if (as === 'json') body = await res.json();
    else if (as === 'buffer') body = Buffer.from(await res.arrayBuffer());
    else body = await res.text();
    return { status: res.status, headers: res.headers, body };
  }
}

/** GET with retries (see httpRequest). */
export function httpGet(url, opts = {}) {
  return httpRequest(url, { ...opts, method: 'GET' });
}
