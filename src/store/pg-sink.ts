import type { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { users, orders, fills, lmOrders, lmFills } from './schema.js';
import { logger } from '../utils/logger.js';
import type { PaperOrder, PaperFill } from '../types/order.js';
import type { LmPaperOrder, LmPaperFill } from '../types/limitless-order.js';

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue
    .then(task)
    .catch((err) => {
      logger.error({ err }, 'pg-sink: queued write failed');
    });
}

export function startPgSink(eventBus: EventEmitter): void {
  eventBus.on('fill', (event: { userId: string; fill: PaperFill }) => {
    enqueueWrite(async () => {
      await db.insert(fills)
        .values({
          tid: event.fill.tid,
          userId: event.userId,
          oid: event.fill.oid,
          coin: event.fill.coin,
          px: event.fill.px,
          sz: event.fill.sz,
          side: event.fill.side,
          time: event.fill.time,
          startPosition: event.fill.startPosition,
          dir: event.fill.dir,
          closedPnl: event.fill.closedPnl,
          hash: event.fill.hash,
          crossed: event.fill.crossed,
          fee: event.fill.fee,
          cloid: event.fill.cloid ?? null,
          feeToken: event.fill.feeToken,
        })
        .onConflictDoNothing({ target: fills.tid });
    });
  });

  eventBus.on('orderUpdate', (event: { userId: string; order: PaperOrder; status: string }) => {
    const o = event.order;
    enqueueWrite(async () => {
      await db.insert(orders)
        .values({
          oid: o.oid,
          cloid: o.cloid ?? null,
          userId: o.userId,
          asset: o.asset,
          coin: o.coin,
          isBuy: o.isBuy,
          sz: o.sz,
          limitPx: o.limitPx,
          orderType: o.orderType,
          tif: o.tif,
          reduceOnly: o.reduceOnly,
          triggerPx: o.triggerPx ?? null,
          tpsl: o.tpsl ?? null,
          isMarket: o.isMarket ?? null,
          grouping: o.grouping,
          status: o.status,
          filledSz: o.filledSz,
          avgPx: o.avgPx,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })
        .onConflictDoUpdate({
          target: orders.oid,
          set: {
            status: o.status,
            filledSz: o.filledSz,
            avgPx: o.avgPx,
            updatedAt: o.updatedAt,
          },
        });
    });
  });

  // --- Limitless event handlers ---

  eventBus.on('lm:fill', (event: { userId: string; fill: LmPaperFill }) => {
    enqueueWrite(async () => {
      await db.insert(lmFills)
        .values({
          tid: event.fill.tid,
          userId: event.userId,
          oid: event.fill.oid,
          marketSlug: event.fill.marketSlug,
          outcome: event.fill.outcome,
          side: event.fill.side,
          price: event.fill.price,
          size: event.fill.size,
          fee: event.fill.fee,
          closedPnl: event.fill.closedPnl,
          time: event.fill.time,
        })
        .onConflictDoNothing({ target: lmFills.tid });
    });
  });

  eventBus.on('lm:orderUpdate', (event: { userId: string; order: LmPaperOrder; status: string }) => {
    enqueueWrite(async () => {
      await db.insert(lmOrders)
        .values({
          oid: event.order.oid,
          userId: event.userId,
          marketSlug: event.order.marketSlug,
          outcome: event.order.outcome,
          side: event.order.side,
          price: event.order.price,
          size: event.order.size,
          orderType: event.order.orderType,
          status: event.order.status,
          filledSize: event.order.filledSize,
          avgFillPrice: event.order.avgFillPrice,
          createdAt: event.order.createdAt,
          updatedAt: event.order.updatedAt,
        })
        .onConflictDoUpdate({
          target: lmOrders.oid,
          set: {
            status: event.order.status,
            filledSize: event.order.filledSize,
            avgFillPrice: event.order.avgFillPrice,
            updatedAt: event.order.updatedAt,
          },
        });
    });
  });

  logger.info('pg-sink listeners attached');
}

export function upsertUser(userId: string, balance: string): void {
  enqueueWrite(async () => {
    await db.insert(users)
      .values({ userId, balance, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: users.userId,
        set: { balance },
      });
  });
}

export function updateUserBalance(userId: string, balance: string): void {
  enqueueWrite(async () => {
    await db.update(users)
      .set({ balance })
      .where(eq(users.userId, userId));
  });
}
