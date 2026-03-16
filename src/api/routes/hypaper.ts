import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { ensureAccount } from '../middleware/auth.js';
import { cancelOrders } from '../../engine/order.js';
import { upsertUser, updateUserBalance } from '../../store/pg-sink.js';

export const hypaperRouter = new Hono();

hypaperRouter.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const type = body.type as string;
  const user = body.user as string | undefined;

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  if (!user || typeof user !== 'string') {
    return c.json({ error: 'Missing user' }, 400);
  }
  const normalizedUser = user.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalizedUser)) {
    return c.json({ error: 'Invalid user address format' }, 400);
  }

  await ensureAccount(normalizedUser);

  try {
    switch (type) {
      case 'resetAccount': {
        // Clear all positions
        const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(normalizedUser));
        const pipeline = redis.pipeline();

        for (const asset of positionAssets) {
          pipeline.del(KEYS.USER_POS(normalizedUser, parseInt(asset, 10)));
        }
        pipeline.del(KEYS.USER_POSITIONS(normalizedUser));
        await pipeline.exec();

        // Cancel only open orders (preserves filled/cancelled history) with events
        const oids = await redis.zrange(KEYS.USER_ORDERS(normalizedUser), 0, -1);
        const openCancels: { a: number; o: number }[] = [];
        for (const oidStr of oids) {
          const oid = parseInt(oidStr, 10);
          const orderData = await redis.hgetall(KEYS.ORDER(oid));
          if (orderData.status === 'open') {
            openCancels.push({ a: parseInt(orderData.asset, 10), o: oid });
          }
        }
        if (openCancels.length > 0) {
          await cancelOrders(normalizedUser, openCancels);
        }

        // Clean up remaining data and reset balance
        const resetPipeline = redis.pipeline();
        resetPipeline.del(KEYS.USER_ORDERS(normalizedUser));
        resetPipeline.del(KEYS.USER_CLOIDS(normalizedUser));
        resetPipeline.del(KEYS.USER_FILLS(normalizedUser));
        resetPipeline.del(KEYS.USER_FUNDINGS(normalizedUser));
        resetPipeline.hset(KEYS.USER_ACCOUNT(normalizedUser), 'balance', config.DEFAULT_BALANCE.toString());
        await resetPipeline.exec();

        // Fire-and-forget sync to Postgres
        upsertUser(normalizedUser, config.DEFAULT_BALANCE.toString());

        return c.json({ status: 'ok', message: 'Account reset' });
      }

      case 'setBalance': {
        const balance = body.balance;
        if (balance === undefined || typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0 || balance > 1_000_000_000) {
          return c.json({ error: 'Missing or invalid balance (must be a finite number between 0 and 1,000,000,000)' }, 400);
        }
        await redis.hset(KEYS.USER_ACCOUNT(normalizedUser), 'balance', balance.toString());

        // Fire-and-forget sync to Postgres
        updateUserBalance(normalizedUser, balance.toString());

        return c.json({ status: 'ok', balance: balance.toString() });
      }

      case 'getAccountInfo': {
        const account = await redis.hgetall(KEYS.USER_ACCOUNT(normalizedUser));
        return c.json({
          userId: account.userId,
          balance: account.balance,
          createdAt: parseInt(account.createdAt, 10),
        });
      }

      default: {
        return c.json({ error: `Unknown hypaper type: ${type}` }, 400);
      }
    }
  } catch (err) {
    logger.error({ err, type }, 'Hypaper error');
    return c.json({ error: 'Internal server error' }, 500);
  }
});
