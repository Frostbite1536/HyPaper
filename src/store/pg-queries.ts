import { desc, eq, and, gte, lte } from 'drizzle-orm';
import { db } from './db.js';
import { fills, lmFills } from './schema.js';
import type { PaperFill } from '../types/order.js';
import type { LmPaperFill } from '../types/limitless-order.js';

export async function getUserFillsPg(userId: string, limit = 100): Promise<PaperFill[]> {
  const rows = await db
    .select()
    .from(fills)
    .where(eq(fills.userId, userId))
    .orderBy(desc(fills.time))
    .limit(limit);

  return rows.map(rowToFill);
}

export async function getUserFillsByTimePg(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<PaperFill[]> {
  const conditions = [eq(fills.userId, userId), gte(fills.time, startTime)];
  if (endTime !== undefined) {
    conditions.push(lte(fills.time, endTime));
  }

  const rows = await db
    .select()
    .from(fills)
    .where(and(...conditions))
    .orderBy(desc(fills.time));

  return rows.map(rowToFill);
}

function rowToFill(row: typeof fills.$inferSelect): PaperFill {
  return {
    coin: row.coin,
    px: row.px,
    sz: row.sz,
    side: row.side as 'B' | 'A',
    time: row.time,
    startPosition: row.startPosition,
    dir: row.dir,
    closedPnl: row.closedPnl,
    hash: row.hash,
    oid: row.oid,
    crossed: row.crossed,
    fee: row.fee,
    tid: row.tid,
    cloid: row.cloid ?? undefined,
    feeToken: row.feeToken,
  };
}

// ---------- Limitless fill queries ----------

export async function getLmUserFillsPg(userId: string, limit = 100): Promise<LmPaperFill[]> {
  const rows = await db
    .select()
    .from(lmFills)
    .where(eq(lmFills.userId, userId))
    .orderBy(desc(lmFills.time))
    .limit(limit);
  return rows.map(rowToLmFill);
}

export async function getLmUserFillsByTimePg(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<LmPaperFill[]> {
  const conditions = [eq(lmFills.userId, userId), gte(lmFills.time, startTime)];
  if (endTime !== undefined) {
    conditions.push(lte(lmFills.time, endTime));
  }
  const rows = await db
    .select()
    .from(lmFills)
    .where(and(...conditions))
    .orderBy(desc(lmFills.time));
  return rows.map(rowToLmFill);
}

function rowToLmFill(row: typeof lmFills.$inferSelect): LmPaperFill {
  return {
    tid: row.tid,
    oid: row.oid,
    userId: row.userId,
    marketSlug: row.marketSlug,
    outcome: row.outcome as 'yes' | 'no',
    side: row.side as 'buy' | 'sell',
    price: row.price,
    size: row.size,
    fee: row.fee,
    closedPnl: row.closedPnl,
    time: row.time,
  };
}
