import { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { sub, mul, add, isZero, gt, lt, lte, gte, div } from '../utils/math.js';
import { nextTid } from '../utils/id.js';
import type { LmPaperOrder, LmPaperFill, LmPaperPosition } from '../types/limitless-order.js';

export class LmOrderMatcher {
  private isRunning = false;
  private pendingMatch = false;
  private eventBus: EventEmitter;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  async matchAll(): Promise<void> {
    if (this.isRunning) {
      this.pendingMatch = true;
      return;
    }
    this.isRunning = true;
    try {
      await this.matchOpenOrders();
      // Re-run if a price update arrived during the cycle
      while (this.pendingMatch) {
        this.pendingMatch = false;
        await this.matchOpenOrders();
      }
    } catch (err) {
      logger.error({ err }, 'LM order matcher error');
    } finally {
      this.pendingMatch = false;
      this.isRunning = false;
    }
  }

  private async matchOpenOrders(): Promise<void> {
    const oids = await redis.smembers(KEYS.LM_ORDERS_OPEN);
    if (oids.length === 0) return;

    for (const oidStr of oids) {
      const oid = parseInt(oidStr, 10);
      const data = await redis.hgetall(KEYS.LM_ORDER(oid));
      if (!data.oid) {
        logger.warn({ oid: oidStr }, 'LM order in open set has no data — removing from open set');
        await redis.srem(KEYS.LM_ORDERS_OPEN, oidStr);
        continue;
      }

      const order = this.parseOrder(data);
      if (order.status !== 'open') {
        await redis.srem(KEYS.LM_ORDERS_OPEN, oidStr);
        continue;
      }

      // Read current prices for this market
      const pricesRaw = await redis.hget(KEYS.LM_MARKET_PRICES, order.marketSlug);
      if (!pricesRaw) continue;

      let prices: { yes: string; no: string };
      try {
        prices = JSON.parse(pricesRaw) as { yes: string; no: string };
      } catch {
        logger.warn({ slug: order.marketSlug }, 'LM corrupted price data — skipping');
        continue;
      }
      const currentPrice = order.outcome === 'yes' ? prices.yes : prices.no;

      // Check fill condition:
      // BUY: fill when currentPrice <= order.price
      // SELL: fill when currentPrice >= order.price
      const shouldFill = order.side === 'buy'
        ? lte(currentPrice, order.price)
        : gte(currentPrice, order.price);

      if (shouldFill) {
        // Fill at market price (guaranteed at-or-better than limit)
        await this.executeFill(order, currentPrice);
      }
    }
  }

  async executeFill(order: LmPaperOrder, fillPrice: string): Promise<boolean> {
    const fillSize = sub(order.size, order.filledSize);
    if (isZero(fillSize)) return false;

    const userId = order.userId;
    const slug = order.marketSlug;
    const outcome = order.outcome;
    const tid = await nextTid();
    const now = Date.now();

    // Read current position
    const posData = await redis.hgetall(KEYS.LM_USER_POS(userId, slug));
    const pos: LmPaperPosition = {
      userId,
      marketSlug: slug,
      yesBalance: posData.yesBalance ?? '0',
      noBalance: posData.noBalance ?? '0',
      yesCost: posData.yesCost ?? '0',
      noCost: posData.noCost ?? '0',
      yesAvgPrice: posData.yesAvgPrice ?? '0',
      noAvgPrice: posData.noAvgPrice ?? '0',
    };

    let closedPnl = '0';

    if (order.side === 'buy') {
      const cost = mul(fillPrice, fillSize);

      // Atomic balance deduction: deduct first, check result, rollback if negative
      const newBalanceStr = await redis.hincrbyfloat(KEYS.LM_USER_ACCOUNT(userId), 'balance', `-${cost}`);
      const newBalanceNum = parseFloat(newBalanceStr);
      if (newBalanceNum < 0) {
        // Rollback: re-add the deducted amount
        await redis.hincrbyfloat(KEYS.LM_USER_ACCOUNT(userId), 'balance', cost);
        logger.warn({ userId, oid: order.oid }, 'LM fill rejected: insufficient balance');
        await this.rejectOrder(order);
        return false;
      }

      // Update position
      const balanceField = outcome === 'yes' ? 'yesBalance' : 'noBalance';
      const costField = outcome === 'yes' ? 'yesCost' : 'noCost';
      const avgField = outcome === 'yes' ? 'yesAvgPrice' : 'noAvgPrice';

      const oldBalance = outcome === 'yes' ? pos.yesBalance : pos.noBalance;
      const oldCost = outcome === 'yes' ? pos.yesCost : pos.noCost;

      const newTokenBalance = add(oldBalance, fillSize);
      const newCost = add(oldCost, cost);
      const newAvgPrice = gt(newTokenBalance, '0') ? div(newCost, newTokenBalance) : '0';

      const pipeline = redis.pipeline();
      // Update position
      pipeline.hset(KEYS.LM_USER_POS(userId, slug),
        'userId', userId,
        'marketSlug', slug,
        balanceField, newTokenBalance,
        costField, newCost,
        avgField, newAvgPrice,
      );
      // Track position
      pipeline.sadd(KEYS.LM_USER_POSITIONS(userId), slug);
      // Mark order filled
      pipeline.hset(KEYS.LM_ORDER(order.oid),
        'status', 'filled',
        'filledSize', order.size,
        'avgFillPrice', fillPrice,
        'updatedAt', now.toString(),
      );
      // Remove from open orders
      pipeline.srem(KEYS.LM_ORDERS_OPEN, order.oid.toString());
      // Track active user
      pipeline.sadd(KEYS.LM_USERS_ACTIVE, userId);
      await pipeline.exec();
    } else {
      // SELL
      const tokenBalanceField = outcome === 'yes' ? 'yesBalance' : 'noBalance';
      const costField = outcome === 'yes' ? 'yesCost' : 'noCost';
      const avgField = outcome === 'yes' ? 'yesAvgPrice' : 'noAvgPrice';
      const avgEntryPrice = outcome === 'yes' ? pos.yesAvgPrice : pos.noAvgPrice;
      const oldCost = outcome === 'yes' ? pos.yesCost : pos.noCost;

      // Atomic token balance deduction: deduct first, check result, rollback if negative
      const negFillSize = `-${fillSize}`;
      const newTokenBalanceStr = await redis.hincrbyfloat(
        KEYS.LM_USER_POS(userId, slug), tokenBalanceField, negFillSize,
      );
      const newTokenBalanceNum = parseFloat(newTokenBalanceStr);
      if (newTokenBalanceNum < 0) {
        // Rollback: re-add the deducted amount
        await redis.hincrbyfloat(KEYS.LM_USER_POS(userId, slug), tokenBalanceField, fillSize);
        logger.warn({ userId, oid: order.oid }, 'LM fill rejected: insufficient tokens');
        await this.rejectOrder(order);
        return false;
      }

      const newTokenBalance = newTokenBalanceStr;
      const proceeds = mul(fillPrice, fillSize);
      closedPnl = mul(sub(fillPrice, avgEntryPrice), fillSize);

      // Proportionally reduce cost basis
      const costReduction = mul(avgEntryPrice, fillSize);
      const newCost = sub(oldCost, costReduction);

      // Re-read the OTHER side's balance for cleanup check (avoid stale data from pos)
      const otherField = outcome === 'yes' ? 'noBalance' : 'yesBalance';
      const otherBalance = (await redis.hget(KEYS.LM_USER_POS(userId, slug), otherField)) ?? '0';

      const pipeline = redis.pipeline();
      // Credit proceeds
      pipeline.hincrbyfloat(KEYS.LM_USER_ACCOUNT(userId), 'balance', proceeds);
      // Update or clean position (token balance already deducted atomically above)
      if (isZero(newTokenBalance)) {
        pipeline.hset(KEYS.LM_USER_POS(userId, slug),
          costField, '0',
          avgField, '0',
        );
        // Check if the other side also zero — if so, remove position
        if (isZero(otherBalance)) {
          pipeline.del(KEYS.LM_USER_POS(userId, slug));
          pipeline.srem(KEYS.LM_USER_POSITIONS(userId), slug);
        }
      } else {
        pipeline.hset(KEYS.LM_USER_POS(userId, slug),
          costField, newCost,
        );
      }
      // Mark order filled
      pipeline.hset(KEYS.LM_ORDER(order.oid),
        'status', 'filled',
        'filledSize', order.size,
        'avgFillPrice', fillPrice,
        'updatedAt', now.toString(),
      );
      pipeline.srem(KEYS.LM_ORDERS_OPEN, order.oid.toString());
      pipeline.sadd(KEYS.LM_USERS_ACTIVE, userId);
      await pipeline.exec();
    }

    // Build fill record
    const fill: LmPaperFill = {
      tid,
      oid: order.oid,
      userId,
      marketSlug: slug,
      outcome,
      side: order.side,
      price: fillPrice,
      size: fillSize,
      fee: '0',
      closedPnl,
      time: now,
    };

    // Update order object for events
    const filledOrder: LmPaperOrder = {
      ...order,
      status: 'filled',
      filledSize: order.size,
      avgFillPrice: fillPrice,
      updatedAt: now,
    };

    this.eventBus.emit('lm:fill', { userId, fill });
    this.eventBus.emit('lm:orderUpdate', { userId, order: filledOrder, status: 'filled' });
    return true;
  }

  private async rejectOrder(order: LmPaperOrder): Promise<void> {
    const now = Date.now();
    const pipeline = redis.pipeline();
    pipeline.hset(KEYS.LM_ORDER(order.oid), 'status', 'rejected', 'updatedAt', now.toString());
    pipeline.srem(KEYS.LM_ORDERS_OPEN, order.oid.toString());
    await pipeline.exec();

    const rejectedOrder: LmPaperOrder = { ...order, status: 'rejected', updatedAt: now };
    this.eventBus.emit('lm:orderUpdate', { userId: order.userId, order: rejectedOrder, status: 'rejected' });
  }

  private parseOrder(data: Record<string, string>): LmPaperOrder {
    return {
      oid: parseInt(data.oid, 10),
      userId: data.userId,
      marketSlug: data.marketSlug,
      outcome: data.outcome as 'yes' | 'no',
      side: data.side as 'buy' | 'sell',
      price: data.price,
      size: data.size,
      orderType: data.orderType as 'limit' | 'market',
      status: data.status as LmPaperOrder['status'],
      filledSize: data.filledSize ?? '0',
      avgFillPrice: data.avgFillPrice ?? '0',
      createdAt: parseInt(data.createdAt, 10),
      updatedAt: parseInt(data.updatedAt, 10),
    };
  }
}
