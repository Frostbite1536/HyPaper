import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { getLmPortfolio, getLmOpenOrders, getLmBalance } from '../../engine/lm-position.js';
import { getLmUserFills, getLmUserFillsByTime } from '../../engine/lm-fill.js';
import { ensureLmAccount } from '../../engine/lm-order.js';
import { logger } from '../../utils/logger.js';

export const lmInfoRouter = new Hono();

lmInfoRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user?.toLowerCase();

  if (!type) return c.json({ error: 'Missing type' }, 400);

  try {
    switch (type) {
      case 'markets': {
        const marketsRaw: Record<string, string> = await redis.hgetall(KEYS.LM_MARKETS);
        const pricesRaw: Record<string, string> = await redis.hgetall(KEYS.LM_MARKET_PRICES);
        const markets = Object.entries(marketsRaw).map(([slug, json]) => {
          const market = JSON.parse(json);
          const prices = pricesRaw[slug] ? JSON.parse(pricesRaw[slug]) : null;
          return { ...market, currentPrices: prices };
        });
        return c.json({ markets });
      }

      case 'market': {
        if (!body.slug) return c.json({ error: 'Missing slug' }, 400);
        const raw = await redis.hget(KEYS.LM_MARKETS, body.slug);
        if (!raw) return c.json({ error: 'Market not found' }, 404);
        const prices = await redis.hget(KEYS.LM_MARKET_PRICES, body.slug);
        return c.json({ ...JSON.parse(raw), currentPrices: prices ? JSON.parse(prices) : null });
      }

      case 'orderbook': {
        if (!body.slug) return c.json({ error: 'Missing slug' }, 400);
        const raw = await redis.get(KEYS.LM_MARKET_ORDERBOOK(body.slug));
        return c.json(raw ? JSON.parse(raw) : { bids: [], asks: [], adjustedMidpoint: null });
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
