import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { getClearinghouseState, getOpenOrders, getFrontendOpenOrders, getOrderStatus } from '../../engine/position.js';
import { getUserFills, getUserFillsByTime } from '../../engine/fill.js';
import { logger } from '../../utils/logger.js';

export const infoRouter = new Hono();

// Endpoints proxied to real HL API
const PROXIED_TYPES = new Set([
  'meta',
  'metaAndAssetCtxs',
  'candleSnapshot',
  'fundingHistory',
  'l2Book',
  'perpsAtOpenInterest',
  'predictedFundings',
]);

infoRouter.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const type: string = body.type;

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  try {
    // Check if we should proxy to real HL
    if (PROXIED_TYPES.has(type)) {
      return proxyToHL(c, body);
    }

    // Handle locally from Redis
    switch (type) {
      case 'allMids': {
        const mids = await redis.hgetall(KEYS.MARKET_MIDS);
        return c.json(mids);
      }

      case 'clearinghouseState': {
        const state = await getClearinghouseState(userId);
        return c.json(state);
      }

      case 'openOrders': {
        const orders = await getOpenOrders(userId);
        return c.json(orders);
      }

      case 'frontendOpenOrders': {
        const orders = await getFrontendOpenOrders(userId);
        return c.json(orders);
      }

      case 'userFills': {
        const fills = await getUserFills(userId);
        return c.json(fills);
      }

      case 'userFillsByTime': {
        const fills = await getUserFillsByTime(
          userId,
          body.startTime ?? 0,
          body.endTime,
        );
        return c.json(fills);
      }

      case 'orderStatus': {
        const status = await getOrderStatus(body.oid);
        return c.json(status);
      }

      case 'activeAssetCtx': {
        if (!body.coin) return c.json({ error: 'Missing coin' }, 400);
        const ctx = await redis.hgetall(KEYS.MARKET_CTX(body.coin));
        return c.json({ coin: body.coin, ctx });
      }

      default: {
        // Try to proxy unknown types to HL
        return proxyToHL(c, body);
      }
    }
  } catch (err) {
    logger.error({ err, type }, 'Info error');
    return c.json({ error: String(err) }, 500);
  }
});

async function proxyToHL(c: any, body: unknown) {
  const res = await fetch(`${config.HL_API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return c.json(data);
}
