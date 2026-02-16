import RedisModule from 'ioredis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const Redis = (RedisModule as any).default ?? RedisModule;

const url = new URL(config.REDIS_URL);
const isTls = url.protocol === 'rediss:';

export const redis: InstanceType<typeof Redis> = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  lazyConnect: true,
  ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err: Error) => logger.error({ err }, 'Redis error'));
redis.on('close', () => logger.warn('Redis connection closed'));

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
    // Verify the connection actually works
    await redis.ping();
  } catch (err) {
    logger.fatal({ err, url: config.REDIS_URL.replace(/\/\/.*@/, '//***@') }, 'Failed to connect to Redis');
    throw new Error(
      `Could not connect to Redis at ${config.REDIS_URL.replace(/\/\/.*@/, '//***@')}. ` +
      'Make sure Redis is running (docker compose up -d) or set REDIS_URL in your .env file.'
    );
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
