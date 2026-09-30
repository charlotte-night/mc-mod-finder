import { createLogger } from './logger.js';

const log = createLogger('ratelimit');

/**
 * Token bucket. Capacity is the burst size; refill is per second.
 */
export class TokenBucket {
  constructor({ capacity, refillPerSecond }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.updatedAt = Date.now();
  }

  /** @returns {{allowed: boolean, retryAfterSeconds: number, remaining: number}} */
  consume(cost = 1, now = Date.now()) {
    const elapsed = (now - this.updatedAt) / 1000;
    this.updatedAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(this.tokens) };
    }
    const missing = cost - this.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(missing / this.refillPerSecond)),
      remaining: Math.floor(this.tokens),
    };
  }
}

/**
 * Per-client limiter with bounded memory: idle buckets are evicted so a public
 * deployment cannot be turned into a memory leak by spraying fake source addresses.
 */
export class RateLimiter {
  constructor({ name, capacity, perMinute, maxClients = 5000 }) {
    this.name = name;
    this.capacity = capacity;
    this.refillPerSecond = perMinute / 60;
    this.maxClients = maxClients;
    this.buckets = new Map();
    this.blocked = 0;
  }

  check(key, cost = 1) {
    if (!key) return { allowed: true, retryAfterSeconds: 0, remaining: this.capacity };
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ capacity: this.capacity, refillPerSecond: this.refillPerSecond });
      this.buckets.set(key, bucket);
      this.prune();
    }
    const result = bucket.consume(cost);
    if (!result.allowed) this.blocked++;
    return result;
  }

  /** Drops buckets that have fully refilled - they carry no state worth keeping. */
  prune() {
    if (this.buckets.size <= this.maxClients) return;
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      const idleSeconds = (now - bucket.updatedAt) / 1000;
      if (idleSeconds * bucket.refillPerSecond >= bucket.capacity) this.buckets.delete(key);
      if (this.buckets.size <= this.maxClients * 0.8) break;
    }
    log.debug(`pruned ${this.name} buckets -> ${this.buckets.size}`);
  }

  stats() {
    return { name: this.name, trackedClients: this.buckets.size, blocked: this.blocked };
  }
}

/**
 * Identifies the caller. Behind a reverse proxy or tunnel every request appears to
 * come from 127.0.0.1, which would collapse all visitors into one bucket - so when
 * TRUST_PROXY is on we read X-Forwarded-For. It is off by default because a client
 * can forge that header when connecting directly.
 */
export function clientKey(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.length > 0) return realIp.trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
