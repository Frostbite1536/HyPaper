import { createMiddleware } from 'hono/factory';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { generateApiKey, generateUserId } from '../../utils/id.js';
import { config } from '../../config.js';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const apiKey = c.req.header('X-API-Key');

  if (apiKey) {
    const userId = await redis.hget(KEYS.AUTH_APIKEYS, apiKey);
    if (!userId) {
      return c.json({ status: 'err', response: 'Invalid API key' }, 401);
    }
    c.set('userId', userId);
  } else {
    // Auto-create anonymous session
    const newApiKey = generateApiKey();
    const userId = generateUserId();
    const now = Date.now();

    const pipeline = redis.pipeline();
    pipeline.hset(KEYS.AUTH_APIKEYS, newApiKey, userId);
    pipeline.hset(KEYS.USER_ACCOUNT(userId),
      'userId', userId,
      'apiKey', newApiKey,
      'balance', config.DEFAULT_BALANCE.toString(),
      'createdAt', now.toString(),
    );
    await pipeline.exec();

    c.set('userId', userId);
    c.header('X-API-Key', newApiKey);
    c.header('X-User-Id', userId);
  }

  await next();
});
