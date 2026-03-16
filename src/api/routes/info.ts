import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { getClearinghouseState, getOpenOrders, getFrontendOpenOrders, getOrderStatus } from '../../engine/position.js';
import { getUserFills, getUserFillsByTime } from '../../engine/fill.js';
import { logger } from '../../utils/logger.js';
import { ensureAccount } from '../middleware/auth.js';

export const infoRouter = new Hono();

// --- Proxy cache ---

interface CacheEntry {
  data: unknown;
  expiry: number;
}

// TTL per proxied type (ms)
const PROXY_TTL: Record<string, number> = {
  meta: 60_000,
  metaAndAssetCtxs: 2_000,
  l2Book: 1_000,
  candleSnapshot: 5_000,
  fundingHistory: 30_000,
  perpsAtOpenInterest: 10_000,
  predictedFundings: 10_000,
};

const DEFAULT_PROXY_TTL = 5_000;
const MAX_CACHE_SIZE = 500;
const proxyCache = new Map<string, CacheEntry>();

function getCacheKey(body: Record<string, unknown>): string {
  // Only cache on known, bounded fields (type + key params) to prevent
  // attackers from creating unbounded cache entries with arbitrary extra fields.
  const { type, coin, asset, user, startTime, endTime, interval, ...rest } = body;
  return JSON.stringify({ type, coin, asset, user, startTime, endTime, interval });
}

// Endpoints proxied to real HL API
const PROXIED_TYPES = new Set(Object.keys(PROXY_TTL));

infoRouter.post('/', async (c) => {
  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const type: string = body.type;
  const rawUser: string | undefined = body.user as string | undefined;
  const user: string | undefined = rawUser?.toLowerCase();
  if (user && !/^0x[a-f0-9]{40}$/.test(user)) {
    return c.json({ error: 'Invalid user address format' }, 400);
  }

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  try {
    // Check if we should proxy to real HL
    if (PROXIED_TYPES.has(type)) {
      return cachedProxyToHL(c, body);
    }

    // For user-specific queries, ensure account exists
    if (user) {
      await ensureAccount(user);
    }

    // Handle locally from Redis
    switch (type) {
      case 'allMids': {
        const mids = await redis.hgetall(KEYS.MARKET_MIDS);
        return c.json(mids);
      }

      case 'clearinghouseState': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const state = await getClearinghouseState(user);
        return c.json(state);
      }

      case 'openOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const orders = await getOpenOrders(user);
        return c.json(orders);
      }

      case 'frontendOpenOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const orders = await getFrontendOpenOrders(user);
        return c.json(orders);
      }

      case 'userFills': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const fills = await getUserFills(user);
        return c.json(fills);
      }

      case 'userFillsByTime': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const startTime = typeof body.startTime === 'number' && Number.isFinite(body.startTime) ? body.startTime : 0;
        const endTime = typeof body.endTime === 'number' && Number.isFinite(body.endTime) ? body.endTime : undefined;
        const fills = await getUserFillsByTime(
          user,
          startTime,
          endTime,
        );
        return c.json(fills);
      }

      case 'orderStatus': {
        if (typeof body.oid !== 'number' || !Number.isFinite(body.oid) || body.oid < 0) {
          return c.json({ error: 'Missing or invalid oid' }, 400);
        }
        const status = await getOrderStatus(body.oid);
        return c.json(status);
      }

      case 'activeAssetCtx': {
        if (!body.coin || typeof body.coin !== 'string') return c.json({ error: 'Missing coin' }, 400);
        if (!/^[A-Za-z0-9@-]+$/.test(body.coin)) return c.json({ error: 'Invalid coin format' }, 400);
        const ctx = await redis.hgetall(KEYS.MARKET_CTX(body.coin));
        return c.json({ coin: body.coin, ctx });
      }

      default: {
        // Try to proxy unknown types to HL (with default TTL)
        return cachedProxyToHL(c, body);
      }
    }
  } catch (err) {
    logger.error({ err, type }, 'Info error');
    return c.json({ error: 'Internal server error' }, 500);
  }
});

async function cachedProxyToHL(c: any, body: Record<string, unknown>) {
  const key = getCacheKey(body);
  const now = Date.now();

  const cached = proxyCache.get(key);
  if (cached && cached.expiry > now) {
    return c.json(cached.data);
  }

  const res = await fetch(`${config.HL_API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  // Only cache successful responses to avoid serving upstream errors
  if (res.ok) {
    const ttl = PROXY_TTL[body.type as string] ?? DEFAULT_PROXY_TTL;
    proxyCache.set(key, { data, expiry: now + ttl });
  }

  // Evict expired entries when cache grows too large
  if (proxyCache.size > MAX_CACHE_SIZE) {
    for (const [k, v] of proxyCache) {
      if (v.expiry <= now) proxyCache.delete(k);
    }
    // If still over limit after evicting expired, drop oldest entries
    if (proxyCache.size > MAX_CACHE_SIZE) {
      const excess = proxyCache.size - MAX_CACHE_SIZE;
      let removed = 0;
      for (const k of proxyCache.keys()) {
        if (removed >= excess) break;
        proxyCache.delete(k);
        removed++;
      }
    }
  }

  return c.json(data);
}
