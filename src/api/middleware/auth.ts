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

  await redis.hset(KEYS.USER_ACCOUNT(wallet),
    'userId', wallet,
    'balance', config.DEFAULT_BALANCE.toString(),
    'createdAt', Date.now().toString(),
  );

  // Fire-and-forget sync to Postgres
  upsertUser(wallet, config.DEFAULT_BALANCE.toString());
}
