/**
 * Browser HTTP layer.
 *
 * Everything the old `server/http.js` did that a browser can still do: JSON GET with
 * a timeout, retries with backoff for 429/5xx, and a per-host concurrency cap so a
 * single search does not open twenty sockets at once.
 *
 * What a browser cannot do is set `User-Agent` (forbidden header) - which is why
 * Modrinth, whose docs ask for one, is queried without it here.
 */

import { ConcurrencyLimiter, RateLimiter, sleep } from './ratelimit.js';

export class ApiError extends Error {
  constructor(message, { status = 0, url = '', body = '', code = null, diagnosis = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.code = code;
    this.diagnosis = diagnosis;
  }
}

export const modrinthLimiter = new ConcurrencyLimiter(4);
export const curseforgeLimiter = new ConcurrencyLimiter(2);

/** Self-imposed request rates per source, so one page cannot spam a public API. */
export const apiLimiters = {
  modrinth: new RateLimiter({ name: 'modrinth', capacity: 20, perMinute: 120 }),
  curseforge: new RateLimiter({ name: 'curseforge', capacity: 10, perMinute: 60 }),
};

function timeoutError(url, timeoutMs) {
  return new ApiError(`请求超时（${timeoutMs} ms）：${url}`, { url, code: 'TIMEOUT' });
}

/**
 * JSON GET.
 *
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, retries?: number,
 *          limiter?: ConcurrencyLimiter|null, rateLimiter?: RateLimiter|null,
 *          signal?: AbortSignal|null, fetchImpl?: typeof fetch}} options
 */
export async function fetchJson(url, {
  headers = {},
  timeoutMs = 20000,
  retries = 2,
  limiter = null,
  rateLimiter = null,
  signal = null,
  fetchImpl = fetch,
} = {}) {
  const run = async () => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onOuterAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          throw new ApiError('请求已取消', { url, code: 'ABORTED' });
        }
        signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      if (rateLimiter) {
        const verdict = rateLimiter.check();
        if (!verdict.allowed) {
          rateLimiter.rejected++;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onOuterAbort);
          throw new ApiError(`本地自我限流：${rateLimiter.name} 的请求过于密集，请 ${verdict.retryAfterSeconds} 秒后再试`, {
            url,
            code: 'LOCAL_RATE_LIMIT',
          });
        }
      }

      try {
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json', ...headers },
          signal: controller.signal,
          // no `credentials`: these APIs are CORS-`*`, and sending cookies would break it
          credentials: 'omit',
          mode: 'cors',
          cache: 'no-store',
        });
        const text = await response.text();
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new ApiError(`HTTP ${response.status}（${url}）`, {
            status: response.status,
            url,
            body: text.slice(0, 300),
          });
          if (retryable && attempt < retries) {
            const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
            const waitMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 10000) : 400 * 2 ** attempt;
            await sleep(waitMs);
            lastError = error;
            continue;
          }
          throw error;
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new ApiError(`返回内容不是合法 JSON（${url}）`, { status: response.status, url, body: text.slice(0, 300) });
        }
      } catch (caught) {
        const aborted = caught?.name === 'AbortError';
        lastError = aborted ? timeoutError(url, timeoutMs) : caught;
        // A TypeError from fetch() in a browser means "network or CORS" - DNS failure,
        // blocked request, or a missing Access-Control-Allow-Origin. Retrying rarely
        // helps, so it is reported as-is; the caller decides whether it is fatal.
        const retryable = !(caught instanceof ApiError) || caught.status === 429 || caught.status >= 500;
        if (attempt < retries && retryable && !aborted) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError ?? new ApiError(`请求失败：${url}`, { url });
  };

  return limiter ? limiter.run(run) : run();
}

/** Explains a fetch failure in words a visitor can act on. */
export function describeFetchError(error, { source = '', url = '' } = {}) {
  if (error instanceof ApiError) {
    if (error.code === 'TIMEOUT') return `${source || '接口'}响应超时，可能是网络较慢，请重试。`;
    if (error.code === 'LOCAL_RATE_LIMIT') return error.message;
    if (error.status === 401 || error.status === 403) return `${source || '接口'}拒绝了这个请求（HTTP ${error.status}）。`;
    if (error.status) return `${source || '接口'}返回 HTTP ${error.status}。`;
    return error.message;
  }
  if (error instanceof TypeError) {
    return `${source || '接口'}无法从浏览器直接访问（网络错误或被 CORS 拦截）。`
      + (url ? `地址：${url}` : '');
  }
  return error?.message ?? String(error);
}
