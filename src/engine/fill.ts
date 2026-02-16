import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import type { PaperFill } from '../types/order.js';

export async function getUserFills(userId: string, limit = 100): Promise<PaperFill[]> {
  const raw: string[] = await redis.lrange(KEYS.USER_FILLS(userId), 0, limit - 1);
  return raw.map((r: string) => JSON.parse(r) as PaperFill);
}

export async function getUserFillsByTime(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<PaperFill[]> {
  const raw: string[] = await redis.lrange(KEYS.USER_FILLS(userId), 0, -1);
  const fills = raw.map((r: string) => JSON.parse(r) as PaperFill);

  return fills.filter((f: PaperFill) => {
    if (f.time < startTime) return false;
    if (endTime && f.time > endTime) return false;
    return true;
  });
}
