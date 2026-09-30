import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('cache');

/**
 * TTL cache that can mirror itself to disk, so a restart does not immediately
 * re-hit the public APIs.
 */
export class TtlCache {
  constructor({ name, ttlMs, max = 800, diskEnabled = false }) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.diskFile = diskEnabled ? path.join(config.dataDir, 'cache', `${name}.json`) : null;
    if (this.diskFile) this.loadFromDisk();
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

  set(key, value, ttlMs = this.ttlMs) {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.scheduleDiskSave();
  }

  async wrap(key, factory, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }

  clear() {
    this.entries.clear();
  }

  loadFromDisk() {
    try {
      if (!fs.existsSync(this.diskFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.diskFile, 'utf8'));
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw.entries ?? {})) {
        if (entry && entry.expiresAt > now) this.entries.set(key, entry);
      }
      log.debug(`restored ${this.entries.size} entries for ${this.name}`);
    } catch (error) {
      log.warn(`could not restore ${this.name} cache`, error.message);
    }
  }

  scheduleDiskSave() {
    if (!this.diskFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 2000);
    this.saveTimer.unref?.();
  }

  saveToDisk() {
    if (!this.diskFile) return;
    try {
      fs.mkdirSync(path.dirname(this.diskFile), { recursive: true });
      const now = Date.now();
      const entries = {};
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt > now) entries[key] = entry;
      }
      fs.writeFileSync(this.diskFile, JSON.stringify({ savedAt: now, entries }));
    } catch (error) {
      log.warn(`could not persist ${this.name} cache`, error.message);
    }
  }
}

export const searchCache = new TtlCache({
  name: 'search',
  ttlMs: config.cache.searchTtlMs,
  diskEnabled: config.cache.diskEnabled,
});

export const projectCache = new TtlCache({
  name: 'project',
  ttlMs: config.cache.projectTtlMs,
  diskEnabled: config.cache.diskEnabled,
});

export const tagCache = new TtlCache({
  name: 'tags',
  ttlMs: config.cache.tagTtlMs,
  diskEnabled: config.cache.diskEnabled,
});

export function cacheStats() {
  return [searchCache.stats(), projectCache.stats(), tagCache.stats()];
}
