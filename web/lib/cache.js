/**
 * A TTL cache that lives in the visitor's browser instead of on a server.
 *
 * Two layers: a Map for the hot path, and localStorage so a page reload does not
 * re-hit the public APIs. localStorage is a shared, quota-limited resource, so the
 * cache is bounded by both entry count and an approximate byte budget, evicts
 * oldest-first, and silently keeps working (memory only) when storage is full or
 * unavailable - private browsing throws on write in some browsers.
 */

const PREFIX = 'mmf:cache:v1:';

function storageAvailable() {
  try {
    const probe = `${PREFIX}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function approximateBytes(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 1024;
  }
}

export class TtlCache {
  constructor({ name, ttlMs, max = 200, maxBytes = 1_500_000, persistent = true }) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.max = max;
    this.maxBytes = maxBytes;
    /** null = not probed yet, false = no usable localStorage. */
    this.persistent = persistent ? null : false;
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.skippedWrites = 0;
  }

  get storageKey() {
    return `${PREFIX}${this.name}`;
  }

  canPersist() {
    if (this.persistent === null) this.persistent = storageAvailable();
    return this.persistent;
  }

  /** Restores unexpired entries, dropping the rest in one pass. */
  load() {
    if (!this.canPersist()) return 0;
    let raw = null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      this.persistent = false;
      return 0;
    }
    if (!raw) return 0;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.removeStorage();
      return 0;
    }
    const now = Date.now();
    let restored = 0;
    for (const [key, entry] of Object.entries(parsed?.entries ?? {})) {
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) continue;
      this.entries.set(key, entry);
      this.bytes += approximateBytes(entry.value) + key.length;
      restored++;
    }
    this.trim();
    return restored;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    // refresh recency for the size-based eviction below
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= approximateBytes(previous.value) + key.length;
    const entry = { value, expiresAt: Date.now() + ttlMs };
    this.entries.set(key, entry);
    this.bytes += approximateBytes(value) + key.length;
    this.trim();
    this.save();
  }

  async wrap(key, factory, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= approximateBytes(entry.value) + key.length;
    this.save();
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.removeStorage();
  }

  /** Drops expired entries, then oldest-first until inside both budgets. */
  trim() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.bytes -= approximateBytes(entry.value) + key.length;
      }
    }
    while (this.entries.size > this.max || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.bytes -= approximateBytes(entry.value) + oldest.length;
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  removeStorage() {
    if (!this.canPersist()) return;
    try {
      localStorage.removeItem(this.storageKey);
    } catch { /* nothing else to do */ }
  }

  /** Mirrors the cache to localStorage; failures are counted, never thrown. */
  save() {
    this.tryPersist();
  }

  /** Writes the live entries; on quota failure halves the cache and retries once. */
  tryPersist() {
    if (!this.canPersist()) {
      this.skippedWrites++;
      return false;
    }
    const now = Date.now();
    const collect = () => {
      const entries = {};
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt > now) entries[key] = entry;
      }
      return entries;
    };
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ savedAt: now, entries: collect() }));
      return true;
    } catch {
      // Quota exceeded (or storage revoked). Give up the oldest half and try once more,
      // then fall back to memory-only for this session.
      this.skippedWrites++;
      const keys = [...this.entries.keys()];
      for (const key of keys.slice(0, Math.ceil(keys.length / 2))) this.entries.delete(key);
      this.trim();
      try {
        localStorage.setItem(this.storageKey, JSON.stringify({ savedAt: now, entries: collect() }));
        return true;
      } catch {
        this.persistent = false;
        return false;
      }
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      size: this.entries.size,
      approxBytes: this.bytes,
      persistent: this.persistent === true,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
      skippedWrites: this.skippedWrites,
    };
  }
}

const MINUTE = 60 * 1000;

export const searchCache = new TtlCache({ name: 'search', ttlMs: 5 * MINUTE, max: 40, maxBytes: 900_000 });
export const projectCache = new TtlCache({ name: 'project', ttlMs: 30 * MINUTE, max: 60, maxBytes: 900_000 });
export const tagCache = new TtlCache({ name: 'tags', ttlMs: 24 * 60 * MINUTE, max: 12, maxBytes: 400_000 });
/** Measurements outlive the host rate so a reload still shows the badges. */
export const itemSpeedCache = new TtlCache({ name: 'speed', ttlMs: 3 * 60 * MINUTE, max: 80, maxBytes: 300_000 });
export const hostSpeedCache = new TtlCache({ name: 'hostspeed', ttlMs: 10 * MINUTE, max: 24, maxBytes: 40_000 });

export const allCaches = [searchCache, projectCache, tagCache, itemSpeedCache, hostSpeedCache];

/** Called once at boot so persisted entries come back before the first query. */
export function hydrateCaches() {
  const restored = {};
  for (const cache of allCaches) restored[cache.name] = cache.load();
  return restored;
}

export function clearAllCaches() {
  for (const cache of allCaches) cache.clear();
}

export function cacheStats() {
  return allCaches.map((cache) => cache.stats());
}
