import { config } from './config.js';
import { createLogger } from './logger.js';
import { createLimiter } from './limiter.js';
import { hostOf } from './normalize.js';
import { TtlCache } from './cache.js';

const log = createLogger('speedtest');
const limiter = createLimiter(config.speedTest.concurrency);

/**
 * Per-result speed, kept longer than the host rate cache so the UI can still show
 * the last measurement, and persisted so a restart does not blank the badges.
 */
export const itemSpeedCache = new TtlCache({
  name: 'speed',
  ttlMs: config.speedTest.hostTtlMs * 3,
  diskEnabled: config.cache.diskEnabled,
});

/** Below this the sample is too short to trust; the rate is still reported, but flagged. */
const MIN_SAMPLE_MS = 150;

/**
 * If the deadline hits after we already pulled this much, the sample is still a
 * valid throughput measurement - a slow CDN must not be reported as a failure.
 */
const MIN_USABLE_BYTES = 32 * 1024;

/**
 * Some CDNs answer 404/403 to a *ranged* request while serving the same file fine
 * without one. CurseForge does exactly this: edge.forgecdn.net replies 404 when a
 * Range header is present, but 302-redirects to mediafilez.forgecdn.net otherwise,
 * and that host does support ranges. So a rejected probe is retried against the
 * redirect target instead of being written off as a failure.
 */
const RANGE_UNFRIENDLY_STATUSES = new Set([403, 404, 405, 416, 501]);

/** Follows the redirect chain once, cheaply, to learn the real file URL. */
async function resolveFinalUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, 'Accept-Encoding': 'identity' },
      signal: controller.signal,
    });
    await response.body?.cancel();
    return response.url && response.url !== url ? response.url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One ranged attempt at steady-state throughput.
 *
 * Time-to-first-byte is measured separately and excluded from the throughput maths;
 * otherwise a distant CDN would look slow purely because of its handshake.
 */
async function measureOnce(url, { maxBytes, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let bytes = 0;
  let ttfbMs = null;
  let status = 0;
  let rangeSupported = false;
  /** Full file size, taken from Content-Range (or Content-Length when there is no range). */
  let reportedSize = null;
  let resolvedUrl = url;
  let error = null;
  let streamMs = 0;
  let truncated = false;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent,
        Range: `bytes=0-${Math.max(maxBytes, 1) - 1}`,
        'Accept-Encoding': 'identity', // compressed bytes would inflate the rate
      },
      signal: controller.signal,
    });
    ttfbMs = Date.now() - startedAt;
    status = response.status;
    resolvedUrl = response.url || url;
    rangeSupported = response.status === 206;
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      const parsed = Number.parseInt(contentRange.split('/')[1] ?? '', 10);
      if (Number.isFinite(parsed)) reportedSize = parsed;
    }
    if (reportedSize === null) {
      const headerLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(headerLength)) reportedSize = headerLength;
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
    }

    const streamStart = Date.now();
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes >= maxBytes) break;
      }
      controller.abort(); // release the rest of the body
    }
    streamMs = Date.now() - streamStart;
  } catch (caught) {
    streamMs = Date.now() - startedAt - (ttfbMs ?? 0);
    const aborted = caught.name === 'AbortError';
    if (aborted && bytes >= MIN_USABLE_BYTES) {
      // Slow link: we ran out of time but read enough to measure honestly.
      truncated = true;
    } else {
      error = aborted ? 'timeout' : caught.message;
    }
  } finally {
    clearTimeout(timer);
  }

  const kbps = streamMs > 0 && bytes > 0 ? Math.round(bytes / 1024 / (streamMs / 1000)) : 0;
  const lowConfidence = !error && bytes > 0 && streamMs < MIN_SAMPLE_MS;
  const ok = !error && bytes > 0;

  return {
    ok,
    resolvedUrl,
    status,
    bytes,
    size: reportedSize,
    ttfbMs,
    streamMs,
    kbps,
    rangeSupported,
    lowConfidence,
    truncated,
    /** Sample was cut short by the deadline rather than by a full read. */
    note: truncated ? '达到超时上限，按已读取的样本计算速率' : null,
    partial: Boolean(reportedSize && bytes < reportedSize),
    measuredAt: new Date().toISOString(),
    error,
  };
}

/**
 * Measures one file, transparently working around CDNs that reject ranged requests.
 *
 * Throughput is a property of the network path rather than of the individual file,
 * which is why SpeedRegistry caches rates per host: the first probe pays for the
 * redirect and TLS handshake, every later file on that host reuses the number.
 *
 * `host` is the host that was asked for (the cache key); `resolvedHost` is where the
 * bytes actually came from.
 */
export async function measureUrl(url, options = {}) {
  const maxBytes = options.maxBytes ?? config.speedTest.maxBytes;
  const timeoutMs = options.timeoutMs ?? config.speedTest.timeoutMs;
  const requestHost = hostOf(url);

  let result = await measureOnce(url, { maxBytes, timeoutMs });
  let resolvedFrom = null;

  if (!result.ok && RANGE_UNFRIENDLY_STATUSES.has(result.status)) {
    const resolved = await resolveFinalUrl(url, timeoutMs);
    if (resolved) {
      const retry = await measureOnce(resolved, { maxBytes, timeoutMs });
      if (retry.ok) {
        result = retry;
        resolvedFrom = url;
        log.debug(`ranged request rejected (${result.status}) - retried against ${resolved}`);
      } else {
        result = { ...result, retryStatus: retry.status, retryError: retry.error };
      }
    }
  }

  return {
    ...result,
    url,
    host: requestHost,
    resolvedUrl: result.resolvedUrl ?? url,
    resolvedHost: hostOf(result.resolvedUrl ?? url),
    resolvedFrom,
  };
}

/**
 * Keeps the per-host rate cache and per-item results so the UI never triggers
 * more than a handful of real downloads.
 */
export class SpeedRegistry {
  constructor({ hostTtlMs = config.speedTest.hostTtlMs, maxHosts = 200 } = {}) {
    this.hostTtlMs = hostTtlMs;
    this.maxHosts = maxHosts;
    this.hosts = new Map();
    this.probes = 0;
    this.bytesRead = 0;
  }

  hostEntry(host) {
    const entry = this.hosts.get(host);
    if (!entry) return null;
    if (Date.now() - Date.parse(entry.measuredAt) > this.hostTtlMs) {
      this.hosts.delete(host);
      return null;
    }
    return entry;
  }

  rememberHost(measurement) {
    if (!measurement.ok || !measurement.host) return;
    this.hosts.set(measurement.host, {
      kbps: measurement.kbps,
      ttfbMs: measurement.ttfbMs,
      streamMs: measurement.streamMs,
      lowConfidence: measurement.lowConfidence,
      measuredAt: measurement.measuredAt,
      sampleUrl: measurement.url,
      sampleBytes: measurement.bytes,
    });
    while (this.hosts.size > this.maxHosts) {
      this.hosts.delete(this.hosts.keys().next().value);
    }
  }

  /**
   * @param {Array<{key: string, url: string, size?: number}>} targets
   * @returns {Promise<Record<string, object>>} key -> speed report
   */
  async measureTargets(targets) {
    const results = {};
    const byHost = new Map();

    for (const target of targets) {
      const host = hostOf(target.url);
      if (!host) {
        results[target.key] = { ok: false, error: 'invalid url', kbps: 0 };
        continue;
      }
      const cached = this.hostEntry(host);
      if (cached) {
        results[target.key] = {
          ...cached,
          url: target.url,
          size: target.size ?? null,
          cached: true,
          ok: true,
        };
        continue;
      }
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(target);
    }

    // One real probe per host; every other target reuses its rate.
    const probeHosts = [...byHost.keys()];
    const measurements = await Promise.all(
      probeHosts.map((host) => limiter(() => measureUrl(byHost.get(host)[0].url))),
    );

    probeHosts.forEach((host, index) => {
      const measurement = measurements[index];
      this.probes++;
      this.bytesRead += measurement.bytes;
      this.rememberHost(measurement);
      log.debug(`probe ${host}: ${measurement.kbps} KB/s (ttfb ${measurement.ttfbMs}ms, ${measurement.bytes} bytes)${measurement.error ? ' error=' + measurement.error : ''}`);
      for (const target of byHost.get(host)) {
        results[target.key] = {
          ...measurement,
          url: target.url,
          size: target.size ?? measurement.size,
          cached: false,
        };
      }
    });

    for (const [key, value] of Object.entries(results)) {
      itemSpeedCache.set(key, value);
    }

    return results;
  }

  /** Last known measurement for a result, if any - used while scoring a search. */
  known(key) {
    return itemSpeedCache.get(key) ?? null;
  }

  stats() {
    return {
      hosts: this.hosts.size,
      probes: this.probes,
      bytesRead: this.bytesRead,
      hostTtlMs: this.hostTtlMs,
      cachedHosts: [...this.hosts.entries()].map(([host, entry]) => ({
        host,
        kbps: entry.kbps,
        ttfbMs: entry.ttfbMs,
        measuredAt: entry.measuredAt,
      })),
    };
  }
}

export const speedRegistry = new SpeedRegistry();
