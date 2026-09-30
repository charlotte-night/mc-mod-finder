/**
 * Politeness limiters.
 *
 * On the old server these existed to protect the deployment from abusive visitors.
 * With everything running in the visitor's own browser that threat is gone, but two
 * limits still matter: we must not hammer a public API from one page, and we must not
 * let a burst of speed tests eat the visitor's bandwidth. So these are advisory
 * self-limits, and the UI explains every one of them.
 */

/** Token bucket with a per-minute refill. */
export class RateLimiter {
  constructor({ name = 'limiter', capacity = 10, perMinute = 60 } = {}) {
    this.name = name;
    this.capacity = capacity;
    this.tokens = capacity;
    this.perMinute = perMinute;
    this.perMs = perMinute / 60000;
    this.last = Date.now();
    this.rejected = 0;
  }

  refill(now = Date.now()) {
    const elapsed = now - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perMs);
    this.last = now;
  }

  /** @returns {{allowed: boolean, retryAfterSeconds: number, remaining: number}} */
  check(now = Date.now()) {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(this.tokens) };
    }
    const needed = 1 - this.tokens;
    return { allowed: false, retryAfterSeconds: Math.ceil(needed / this.perMs / 1000), remaining: 0 };
  }

  stats() {
    this.refill();
    return {
      name: this.name,
      tokens: Number(this.tokens.toFixed(2)),
      capacity: this.capacity,
      perMinute: this.perMinute,
      rejected: this.rejected,
    };
  }
}

/** Caps how many tasks run at once and hands queued work out first-in-first-out. */
export class ConcurrencyLimiter {
  constructor(limit = 3) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  get pending() {
    return this.queue.length;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.limit && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
