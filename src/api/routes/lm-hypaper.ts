import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { ensureLmAccount } from '../../engine/lm-order.js';
import { upsertUser, updateUserBalance } from '../../store/pg-sink.js';

export const lmHypaperRouter = new Hono();

lmHypaperRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user;

  if (!type) return c.json({ error: 'Missing type' }, 400);
  if (!user || typeof user !== 'string') return c.json({ error: 'Missing user' }, 400);
  const normalizedUser = user.toLowerCase();
  await ensureLmAccount(normalizedUser);

  try {
    switch (type) {
      case 'resetAccount': {
        // Get all position slugs
        const slugs = await redis.smembers(KEYS.LM_USER_POSITIONS(normalizedUser));

        const pipeline = redis.pipeline();
        // Delete each position hash
        for (const slug of slugs) {
          pipeline.del(KEYS.LM_USER_POS(normalizedUser, slug));
        }
        // Delete positions set
        pipeline.del(KEYS.LM_USER_POSITIONS(normalizedUser));

        // Cancel all open orders
        const oids = await redis.zrange(KEYS.LM_USER_ORDERS(normalizedUser), 0, -1);
        for (const oidStr of oids) {
          const oid = parseInt(oidStr, 10);
          pipeline.hset(KEYS.LM_ORDER(oid), 'status', 'cancelled', 'updatedAt', Date.now().toString());
          pipeline.srem(KEYS.LM_ORDERS_OPEN, oidStr);
        }

        // Delete user orders and fills lists
        pipeline.del(KEYS.LM_USER_ORDERS(normalizedUser));
        pipeline.del(KEYS.LM_USER_FILLS(normalizedUser));

        // Reset balance
        pipeline.hset(KEYS.LM_USER_ACCOUNT(normalizedUser), 'balance', config.LM_DEFAULT_BALANCE.toString());

        await pipeline.exec();

        upsertUser(normalizedUser, config.LM_DEFAULT_BALANCE.toString());

        return c.json({ status: 'ok', message: 'LM account reset' });
      }

      case 'setBalance': {
        const newBalance = body.balance;
        if (typeof newBalance !== 'number' || newBalance < 0 || newBalance > 1_000_000_000) {
          return c.json({ error: 'Invalid balance (must be non-negative number up to 1,000,000,000)' }, 400);
        }
        await redis.hset(KEYS.LM_USER_ACCOUNT(normalizedUser), 'balance', newBalance.toString());
        updateUserBalance(normalizedUser, newBalance.toString());
        return c.json({ status: 'ok', balance: newBalance.toString() });
      }

      case 'getAccountInfo': {
        const account = await redis.hgetall(KEYS.LM_USER_ACCOUNT(normalizedUser));
        return c.json({
          userId: account.userId,
          balance: account.balance,
          createdAt: parseInt(account.createdAt, 10),
        });
      }

      default:
        return c.json({ error: `Unknown type: ${type}` }, 400);
    }
  } catch (err) {
    logger.error({ err, type }, 'LM hypaper error');
    return c.json({ error: 'Internal server error' }, 500);
  }
});
