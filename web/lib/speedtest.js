/**
 * Real throughput sampling, run from the visitor's own browser.
 *
 * The old server pulled the bytes itself; here the visitor's machine does, which is
 * actually the more honest measurement - it is their connection to the CDN that decides
 * how long a download takes, not the server's.
 *
 * Two browser-specific facts shape this file:
 *
 * 1. Cross-origin responses only expose a few headers. `Content-Range` is not one of
 *    them, so the full file size is usually unknowable here; we report how many bytes
 *    we sampled and leave size to the platform metadata.
 * 2. Some hosts answer the Modrinth CDN's bare URL with a redirect that omits
 *    `Access-Control-Allow-Origin`, which makes the *body* unreadable even though the
 *    redirect target serves ranges with CORS. Such hosts are retried against an
 *    alternate hostname, and hosts that refuse byte sampling are remembered so the UI
 *    can say "not measurable here" instead of pretending a neutral score is a verdict.
 */

import { hostOf } from './normalize.js';
import { hostSpeedCache, itemSpeedCache } from './cache.js';
import { ConcurrencyLimiter } from './ratelimit.js';

const MIN_SAMPLE_MS = 150;
/** If the deadline hits after we already pulled this much, the sample is still valid. */
const MIN_USABLE_BYTES = 32 * 1024;
/** Sample length can never exceed what the caller will read. */
const HARD_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULTS = {
  maxBytes: 1024 * 1024,
  timeoutMs: 8000,
  concurrency: 3,
};

/** Hostname variants worth trying when the canonical one blocks cross-origin reads. */
export function urlCandidates(url) {
  const candidates = [url];
  try {
    const parsed = new URL(url);
    if (/^cdn\.modrinth\.com$/i.test(parsed.hostname)) {
      const alt = new URL(url);
      alt.hostname = 'cdn-alt.modrinth.com';
      candidates.push(alt.toString());
    }
  } catch { /* a malformed URL is reported by the caller */ }
  return candidates;
}

function isMeasurement(entry) {
  return entry && (entry.kbps > 0 || entry.error || entry.unsupported);
}

function classifyFailure(error) {
  const name = error?.name;
  if (name === 'AbortError') return { error: 'timeout', unsupported: false };
  // In a browser a cross-origin body read that is not permitted surfaces as a TypeError.
  if (error instanceof TypeError) {
    return { error: 'CORS 或网络错误：该下载源不允许浏览器读取文件内容', unsupported: true };
  }
  return { error: error?.message ?? String(error), unsupported: false };
}

/** Failures that a second attempt may well fix. */
const RETRYABLE_ERRORS = new Set(['timeout', 'CORS 或网络错误：该下载源不允许浏览器读取文件内容', 'Failed to fetch', 'network error', 'terminated']);

/**
 * One ranged attempt at steady-state throughput. Time-to-first-byte is measured
 * separately and excluded from the maths, so a distant CDN is not punished for its
 * handshake.
 */
async function measureOnce(url, { maxBytes, timeoutMs, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let bytes = 0;
  let ttfbMs = null;
  let status = 0;
  let rangeSupported = false;
  let error = null;
  let unsupported = false;
  let streamMs = 0;
  let truncated = false;
  let reader = null;

  try {
    const response = await fetchImpl(url, {
      headers: {
        Range: `bytes=0-${Math.max(maxBytes, 1) - 1}`,
        // compressed bytes would inflate the measured rate
        'Accept-Encoding': 'identity',
      },
      signal: controller.signal,
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    ttfbMs = Date.now() - startedAt;
    status = response.status;
    rangeSupported = response.status === 206;

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
    }

    const streamStart = Date.now();
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
        if (bytes >= maxBytes) {
          truncated = true;
          break;
        }
      }
      streamMs = Date.now() - streamStart;
      if (truncated) await reader.cancel().catch(() => {});
    }
  } catch (caught) {
    streamMs = Date.now() - startedAt - (ttfbMs ?? 0);
    const aborted = caught?.name === 'AbortError';
    if (aborted && bytes >= MIN_USABLE_BYTES) {
      // Slow link: we ran out of time but read enough to measure honestly.
      truncated = true;
    } else {
      const failure = classifyFailure(caught);
      error = failure.error;
      unsupported = failure.unsupported;
    }
  } finally {
    clearTimeout(timer);
    if (reader) reader.releaseLock?.();
  }

  const kbps = streamMs > 0 && bytes > 0 ? Math.round(bytes / 1024 / (streamMs / 1000)) : 0;
  const lowConfidence = !error && bytes > 0 && streamMs < MIN_SAMPLE_MS;
  const ok = !error && bytes > 0;

  return {
    ok,
    status,
    bytes,
    ttfbMs,
    streamMs,
    kbps,
    rangeSupported,
    lowConfidence,
    truncated,
    unsupported,
    note: truncated ? '达到读取上限，按已读取的样本计算速率' : null,
    measuredAt: new Date().toISOString(),
    error,
  };
}

/**
 * Measures one file.
 *
 * Three things are tried, in order, because any of them can be the reason a single
 * attempt fails on a real network:
 *
 * 1. the URL as given;
 * 2. a network hiccup or a cold TLS handshake gets one retry on the same URL - a real
 *    CDN answers a second request far faster than it answered the first;
 * 3. hosts that block cross-origin reads are retried against an alternate hostname
 *    (`cdn-alt.modrinth.com`), which serves the same bytes with a permissive header.
 */
export async function measureUrl(url, options = {}) {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULTS.maxBytes, HARD_MAX_BYTES);
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const requestHost = hostOf(url);
  const candidates = options.candidates ?? urlCandidates(url);

  let result = null;
  let usedUrl = url;
  let lastFailure = null;

  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // The retry gets a longer deadline: a cold TLS handshake and a saturated edge node
      // are exactly the cases a second, more patient attempt fixes.
      const measured = await measureOnce(candidate, {
        maxBytes,
        timeoutMs: attempt === 0 ? timeoutMs : Math.min(Math.round(timeoutMs * 1.8), 20000),
        fetchImpl: options.fetchImpl,
      });
      if (measured.ok) {
        result = measured;
        usedUrl = candidate;
        break;
      }
      lastFailure = measured;
      // A timeout or a dropped connection is worth exactly one retry: a real CDN answers
      // the second request far faster than the first. Anything else is a real answer.
      if (!RETRYABLE_ERRORS.has(measured.error)) break;
    }
    if (result) break;
    // A different hostname is only worth trying when the failure could be a cross-origin
    // read refusal (the Modrinth CDN redirect) - not for a working host that said 404.
    const worthAlternateHost = Boolean(lastFailure?.unsupported) || /^HTTP (403|404|405|416|501)$/.test(lastFailure?.error ?? '');
    if (!worthAlternateHost) break;
  }

  if (!result && lastFailure) result = lastFailure;

  return {
    ...result,
    url,
    requestedUrl: usedUrl,
    host: requestHost,
    resolvedHost: hostOf(usedUrl),
    resolvedFrom: usedUrl === url ? null : url,
  };
}

/**
 * Keeps the per-host rate cache and per-item results, so the UI never triggers more
 * real downloads than the visitor asked for.
 */
export class SpeedRegistry {
  constructor({ concurrency = DEFAULTS.concurrency } = {}) {
    this.limiter = new ConcurrencyLimiter(concurrency);
    this.probes = 0;
    this.bytesRead = 0;
    this.unsupportedHosts = new Set();
  }

  /** @returns {object|null} a still-valid measurement for this host, if any */
  hostEntry(host) {
    if (!host) return null;
    const entry = hostSpeedCache.get(host);
    if (!entry) return null;
    if (entry.unsupported) {
      this.unsupportedHosts.add(host);
      return { ...entry, cached: true, ok: false };
    }
    return { ...entry, cached: true, ok: true };
  }

  rememberHost(measurement) {
    if (!measurement?.host) return;
    if (!measurement.ok) {
      if (measurement.unsupported) {
        this.unsupportedHosts.add(measurement.host);
        hostSpeedCache.set(measurement.host, {
          unsupported: true,
          error: measurement.error,
          measuredAt: measurement.measuredAt,
        }, 6 * 60 * 60 * 1000);
      }
      return;
    }
    this.unsupportedHosts.delete(measurement.host);
    hostSpeedCache.set(measurement.host, {
      kbps: measurement.kbps,
      ttfbMs: measurement.ttfbMs,
      streamMs: measurement.streamMs,
      lowConfidence: measurement.lowConfidence,
      measuredAt: measurement.measuredAt,
      sampleUrl: measurement.requestedUrl ?? measurement.url,
      sampleBytes: measurement.bytes,
    });
  }

  /**
   * @param {Array<{key: string, url: string, size?: number}>} targets
   * @returns {Promise<{results: Record<string, object>, probes: number, bytesRead: number}>}
   */
  async measureTargets(targets, { onProgress = null } = {}) {
    const results = {};
    const byHost = new Map();
    let done = 0;
    const total = targets.length;
    const report = (key, value) => {
      results[key] = value;
      done++;
      onProgress?.({ done, total, key, value });
    };

    for (const target of targets) {
      const host = hostOf(target.url);
      if (!host) {
        report(target.key, { ok: false, kbps: 0, url: target.url, error: '无效的下载地址', unsupported: false, measuredAt: new Date().toISOString() });
        continue;
      }
      const cached = this.hostEntry(host);
      if (cached) {
        report(target.key, { ...cached, url: target.url, size: target.size ?? null });
        continue;
      }
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(target);
    }

    // One real probe per host; every other target on that host reuses the number.
    const probeHosts = [...byHost.keys()];
    await Promise.all(probeHosts.map((host) => this.limiter.run(async () => {
      const measurement = await measureUrl(byHost.get(host)[0].url);
      this.probes++;
      this.bytesRead += measurement.bytes ?? 0;
      this.rememberHost(measurement);
      for (const target of byHost.get(host)) {
        const entry = {
          ...measurement,
          url: target.url,
          size: target.size ?? measurement.size ?? null,
          cached: false,
        };
        itemSpeedCache.set(target.key, entry);
        report(target.key, entry);
      }
    })));

    return { results, probes: this.probes, bytesRead: this.bytesRead };
  }

  /** Last known measurement for a result, if any - used while scoring a search. */
  known(key) {
    const entry = itemSpeedCache.get(key);
    return isMeasurement(entry) ? entry : null;
  }

  /** True when this host is known to refuse byte sampling, so scoring can explain itself. */
  isUnsupported(urlOrHost) {
    const host = urlOrHost?.includes('://') ? hostOf(urlOrHost) : urlOrHost;
    if (!host) return false;
    if (this.unsupportedHosts.has(host)) return true;
    const entry = hostSpeedCache.get(host);
    if (entry?.unsupported) {
      this.unsupportedHosts.add(host);
      return true;
    }
    return false;
  }

  stats() {
    return {
      probes: this.probes,
      bytesRead: this.bytesRead,
      hosts: hostSpeedCache.entries.size,
      unsupportedHosts: [...this.unsupportedHosts],
      cachedHosts: [...hostSpeedCache.entries.entries()].map(([host, entry]) => ({
        host,
        kbps: entry.value?.kbps ?? 0,
        unsupported: Boolean(entry.value?.unsupported),
        measuredAt: entry.value?.measuredAt ?? null,
      })),
    };
  }

  clear() {
    this.probes = 0;
    this.bytesRead = 0;
    this.unsupportedHosts.clear();
    hostSpeedCache.clear();
    itemSpeedCache.clear();
  }
}

export const speedRegistry = new SpeedRegistry();
