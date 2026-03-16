import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { getLmPortfolio, getLmOpenOrders, getLmBalance } from '../../engine/lm-position.js';
import { getLmUserFills, getLmUserFillsByTime } from '../../engine/lm-fill.js';
import { ensureLmAccount } from '../../engine/lm-order.js';
import { logger } from '../../utils/logger.js';

export const lmInfoRouter = new Hono();

lmInfoRouter.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const type: string = body.type as string;
  const user: string | undefined = (body.user as string | undefined)?.toLowerCase();

  if (!type) return c.json({ error: 'Missing type' }, 400);
  if (user && !/^0x[a-f0-9]{40}$/.test(user)) {
    return c.json({ error: 'Invalid user address format' }, 400);
  }

  try {
    switch (type) {
      case 'markets': {
        const marketsRaw: Record<string, string> = await redis.hgetall(KEYS.LM_MARKETS);
        const pricesRaw: Record<string, string> = await redis.hgetall(KEYS.LM_MARKET_PRICES);
        const markets: unknown[] = [];
        for (const [slug, json] of Object.entries(marketsRaw)) {
          try {
            const market = JSON.parse(json);
            const prices = pricesRaw[slug] ? JSON.parse(pricesRaw[slug]) : null;
            markets.push({ ...market, currentPrices: prices });
          } catch {
            logger.warn({ slug }, 'LM corrupted market data — skipping');
          }
        }
        return c.json({ markets });
      }

      case 'market': {
        if (!body.slug) return c.json({ error: 'Missing slug' }, 400);
        const raw = await redis.hget(KEYS.LM_MARKETS, body.slug as string);
        if (!raw) return c.json({ error: 'Market not found' }, 404);
        try {
          const prices = await redis.hget(KEYS.LM_MARKET_PRICES, body.slug as string);
          return c.json({ ...JSON.parse(raw), currentPrices: prices ? JSON.parse(prices) : null });
        } catch {
          return c.json({ error: 'Corrupted market data' }, 500);
        }
      }

      case 'orderbook': {
        if (!body.slug) return c.json({ error: 'Missing slug' }, 400);
        const raw = await redis.get(KEYS.LM_MARKET_ORDERBOOK(body.slug as string));
        try {
          return c.json(raw ? JSON.parse(raw) : { bids: [], asks: [], adjustedMidpoint: null });
        } catch {
          return c.json({ bids: [], asks: [], adjustedMidpoint: null });
        }
      }

      case 'portfolio': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        await ensureLmAccount(user);
        const portfolio = await getLmPortfolio(user);
        return c.json(portfolio);
      }

      case 'openOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        await ensureLmAccount(user);
        const orders = await getLmOpenOrders(user);
        return c.json(orders);
      }

      case 'userFills': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getLmUserFills(user));
      }

      case 'userFillsByTime': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const startTime = typeof body.startTime === 'number' ? body.startTime : 0;
        const endTime = typeof body.endTime === 'number' ? body.endTime : undefined;
        return c.json(await getLmUserFillsByTime(user, startTime, endTime));
      }

      case 'balance': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        await ensureLmAccount(user);
        const balance = await getLmBalance(user);
        return c.json({ balance });
      }

      default:
        return c.json({ error: `Unknown type: ${type}` }, 400);
    }
  } catch (err) {
    logger.error({ err, type }, 'LM info error');
    return c.json({ error: 'Internal server error' }, 500);
  }
});
