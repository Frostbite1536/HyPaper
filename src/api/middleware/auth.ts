import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { upsertUser } from '../../store/pg-sink.js';

/**
 * Ensure a wallet address has an account in Redis.
 * Auto-creates with default balance on first touch.
 */
export async function ensureAccount(wallet: string): Promise<void> {
  const exists = await redis.exists(KEYS.USER_ACCOUNT(wallet));
  if (exists) return;

  // Use HSETNX on a sentinel field to atomically claim creation.
  // If another concurrent request already created the account, this returns 0.
  const created = await redis.hsetnx(KEYS.USER_ACCOUNT(wallet), 'userId', wallet);
  if (!created) return;

  // Set balance and createdAt in a single pipeline to avoid a window
  // where another reader sees userId set but balance missing.
  const pipeline = redis.pipeline();
  pipeline.hset(KEYS.USER_ACCOUNT(wallet),
    'balance', config.DEFAULT_BALANCE.toString(),
    'createdAt', Date.now().toString(),
  );
  await pipeline.exec();

  // Fire-and-forget sync to Postgres
  upsertUser(wallet, config.DEFAULT_BALANCE.toString());
}
