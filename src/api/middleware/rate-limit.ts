import { createMiddleware } from 'hono/factory';
import { config } from '../../config.js';

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

// Evict stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  const key = c.get('userId') ?? c.req.header('x-forwarded-for') ?? 'anon';
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.RATE_LIMIT_WINDOW_MS };
    buckets.set(key, bucket);
  }

  bucket.count++;

  c.header('X-RateLimit-Limit', config.RATE_LIMIT_MAX.toString());
  c.header('X-RateLimit-Remaining', Math.max(0, config.RATE_LIMIT_MAX - bucket.count).toString());
  c.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000).toString());

  if (bucket.count > config.RATE_LIMIT_MAX) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  await next();
});
