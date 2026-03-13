import { EventEmitter } from 'node:events';
import { HttpClient, MarketFetcher } from '@limitless-exchange/sdk';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { add, isZero } from '../utils/math.js';
import { cancelLmOrder } from '../engine/lm-order.js';
import { nextTid } from '../utils/id.js';
import type { LmPaperFill } from '../types/limitless-order.js';

export class LmResolver {
  private eventBus: EventEmitter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private marketFetcher: MarketFetcher;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
    const httpClient = new HttpClient({ baseURL: config.LM_API_URL });
    this.marketFetcher = new MarketFetcher(httpClient);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.checkResolutions().catch((err) => {
        logger.error({ err }, 'LM resolution check failed');
      });
    }, config.LM_RESOLVER_INTERVAL_MS);
  }

  private async checkResolutions(): Promise<void> {
    // Get all active users
    const activeUsers = await redis.smembers(KEYS.LM_USERS_ACTIVE);
    if (activeUsers.length === 0) return;

    // Collect unique slugs across all users
    const slugSet = new Set<string>();
    for (const userId of activeUsers) {
      const slugs = await redis.smembers(KEYS.LM_USER_POSITIONS(userId));
      for (const slug of slugs) {
        slugSet.add(slug);
      }
    }

    if (slugSet.size === 0) return;

    // Check each market for resolution
    for (const slug of slugSet) {
      try {
        const market = await this.marketFetcher.getMarket(slug);
        if (market.winningOutcomeIndex == null) continue;

        // INV-XCOMP-004: Bounds-check winningOutcomeIndex (must be 0 or 1)
        if (market.winningOutcomeIndex !== 0 && market.winningOutcomeIndex !== 1) {
          logger.warn({ slug, winningOutcomeIndex: market.winningOutcomeIndex }, 'LM market has invalid winningOutcomeIndex — skipping');
          continue;
        }

        // Market resolved! winningOutcomeIndex 0 = YES wins, 1 = NO wins
        const winningOutcome = market.winningOutcomeIndex === 0 ? 'yes' : 'no';

        logger.info({ slug, winningOutcome }, 'LM market resolved');

        // Resolve all user positions in this market
        for (const userId of activeUsers) {
          const posData = await redis.hgetall(KEYS.LM_USER_POS(userId, slug));
          if (!posData.yesBalance && !posData.noBalance) continue;

          const yesBalance = posData.yesBalance ?? '0';
          const noBalance = posData.noBalance ?? '0';

          // Winning shares pay $1.00 each
          const payout = winningOutcome === 'yes' ? yesBalance : noBalance;
          const losingBalance = winningOutcome === 'yes' ? noBalance : yesBalance;

          if (isZero(payout) && isZero(losingBalance)) continue;

          // Credit payout to balance
          if (!isZero(payout)) {
            await redis.hincrbyfloat(KEYS.LM_USER_ACCOUNT(userId), 'balance', payout);
          }

          // Create resolution fill record
          const tid = await nextTid();
          const now = Date.now();

          const totalCost = add(posData.yesCost ?? '0', posData.noCost ?? '0');
          const closedPnl = isZero(totalCost) ? payout : (
            // PnL = payout - total cost invested in this market
            add(payout, `-${totalCost}`)
          );

          const fill: LmPaperFill = {
            tid,
            oid: null,
            userId,
            marketSlug: slug,
            outcome: winningOutcome as 'yes' | 'no',
            side: 'resolution',
            price: isZero(payout) ? '0' : '1',
            size: add(yesBalance, noBalance),
            fee: '0',
            closedPnl,
            time: now,
          };

          // Clean up position
          await redis.del(KEYS.LM_USER_POS(userId, slug));
          await redis.srem(KEYS.LM_USER_POSITIONS(userId), slug);

          // Emit fill event (consumed by pg-sink and ws/server)
          this.eventBus.emit('lm:fill', { userId, fill });
        }

        // Remove users with no remaining positions from active set
        for (const userId of activeUsers) {
          const remainingSlugs = await redis.smembers(KEYS.LM_USER_POSITIONS(userId));
          if (remainingSlugs.length === 0) {
            await redis.srem(KEYS.LM_USERS_ACTIVE, userId);
          }
        }

        // Cancel any remaining open orders for this market
        const openOids = await redis.smembers(KEYS.LM_ORDERS_OPEN);
        for (const oidStr of openOids) {
          const oid = parseInt(oidStr, 10);
          const orderData = await redis.hgetall(KEYS.LM_ORDER(oid));
          if (orderData.marketSlug === slug && orderData.status === 'open') {
            await cancelLmOrder(orderData.userId, oid);
          }
        }

        // Clean up market from caches
        await redis.hdel(KEYS.LM_MARKETS, slug);
        await redis.hdel(KEYS.LM_MARKET_PRICES, slug);
        await redis.del(KEYS.LM_MARKET_ORDERBOOK(slug));
      } catch (err) {
        logger.warn({ err, slug }, 'Failed to check LM market resolution');
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
