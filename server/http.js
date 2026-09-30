import { config } from './config.js';
import { createLogger } from './logger.js';
import { createLimiter, sleep } from './limiter.js';

const log = createLogger('http');
const modrinthLimit = createLimiter(4);
const curseforgeLimit = createLimiter(2);

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * JSON GET with redirect handling, timeout, retry and a per-host concurrency cap.
 * Node's fetch follows the CDN's 307 while preserving our headers, which is what makes
 * the ranged speed probe below work.
 */
export async function fetchJson(url, { headers = {}, timeoutMs = 20000, retries = 2, limiter = null } = {}) {
  const run = async () => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...headers },
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          const error = new HttpError(`HTTP ${res.status} for ${url}`, { status: res.status, url, body: text.slice(0, 300) });
          if (retryable && attempt < retries) {
            const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
            const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 400 * 2 ** attempt;
            log.warn(`retrying ${url} after ${waitMs}ms (status ${res.status})`);
            await sleep(waitMs);
            lastError = error;
            continue;
          }
          throw error;
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(`invalid JSON from ${url}`, { status: res.status, url, body: text.slice(0, 300) });
        }
      } catch (error) {
        lastError = error;
        if (error.name === 'AbortError') {
          lastError = new HttpError(`timeout after ${timeoutMs}ms for ${url}`, { url });
        }
        if (attempt < retries && !(error instanceof HttpError && error.status && error.status < 500 && error.status !== 429)) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new HttpError(`request failed for ${url}`, { url });
  };

  return limiter ? limiter(run) : run();
}

export const limiters = { modrinth: modrinthLimit, curseforge: curseforgeLimit };
