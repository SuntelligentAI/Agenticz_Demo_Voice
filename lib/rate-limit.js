// Sliding-window rate limiter factory, keyed by arbitrary string.
// In-memory; per-instance. TODO: Replace with Upstash Redis in Phase 6 hardening.

export function createRateLimiter({ windowMs, max }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimiter: windowMs must be a positive number');
  }
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error('createRateLimiter: max must be a positive integer');
  }

  const attempts = new Map();
  const defaultClock = () => Date.now();

  function prune(key, now) {
    const cutoff = now - windowMs;
    const existing = attempts.get(key);
    if (!existing) return [];
    const list = existing.filter((t) => t > cutoff);
    if (list.length === 0) attempts.delete(key);
    else if (list.length !== existing.length) attempts.set(key, list);
    return list;
  }

  return {
    check(key, now = defaultClock()) {
      const list = prune(key, now);
      if (list.length >= max) {
        return {
          allowed: false,
          retryInMs: list[0] + windowMs - now,
        };
      }
      return { allowed: true };
    },

    record(key, now = defaultClock()) {
      const list = attempts.get(key) || [];
      list.push(now);
      attempts.set(key, list);
    },

    clear(key) {
      attempts.delete(key);
    },

    cleanup(now = defaultClock()) {
      const cutoff = now - windowMs;
      for (const [key, list] of attempts.entries()) {
        const filtered = list.filter((t) => t > cutoff);
        if (filtered.length === 0) attempts.delete(key);
        else if (filtered.length !== list.length) attempts.set(key, filtered);
      }
    },

    reset() {
      attempts.clear();
    },

    size() {
      return attempts.size;
    },
  };
}
