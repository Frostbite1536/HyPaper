import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { HlWebSocketClient } from './ws-client.js';
import { PriceUpdater } from './price-updater.js';
import { OrderMatcher } from './order-matcher.js';
import { FundingWorker } from './funding-worker.js';
import { LmPriceUpdater } from './lm-price-updater.js';
import { LmWebSocketClientWrapper } from './lm-ws-client.js';
import { LmOrderMatcher } from './lm-order-matcher.js';
import { LmResolver } from './lm-resolver.js';
import type { HlMeta, HlAssetCtx } from '../types/hl.js';
import type { OrderbookUpdate } from '@limitless-exchange/sdk';

export const eventBus = new EventEmitter();
export const orderMatcher = new OrderMatcher(eventBus);
export const lmOrderMatcher = new LmOrderMatcher(eventBus);

export class Worker {
  private wsClient: HlWebSocketClient | null = null;
  private priceUpdater: PriceUpdater;
  private orderMatcher: OrderMatcher;
  private fundingWorker: FundingWorker;
  private lmPriceUpdater: LmPriceUpdater | null = null;
  private lmWsClient: LmWebSocketClientWrapper | null = null;
  private lmOrderMatcherRef: LmOrderMatcher | null = null;
  private lmResolver: LmResolver | null = null;

  constructor() {
    this.orderMatcher = orderMatcher;
    this.fundingWorker = new FundingWorker(eventBus);
    this.priceUpdater = new PriceUpdater(() => {
      // Fire-and-forget match on every price update
      this.orderMatcher.matchAll();
    }, eventBus);

    this.wsClient = new HlWebSocketClient((channel, data) => {
      this.priceUpdater.handleMessage(channel, data).catch((err) => {
        logger.error({ err, channel }, 'Price updater message handling failed');
      });
    });

    if (config.LM_ENABLED) {
      this.lmOrderMatcherRef = lmOrderMatcher;
      this.lmPriceUpdater = new LmPriceUpdater(eventBus);

      this.lmWsClient = new LmWebSocketClientWrapper((event, data) => {
        if (event === 'orderbookUpdate') {
          const update = data as OrderbookUpdate;
          this.lmPriceUpdater!.handleOrderbookUpdate(update.marketSlug, update.orderbook);
        }
      });

      this.lmResolver = new LmResolver(eventBus);

      // Wire up: when prices change, run matcher
      eventBus.on('lm:mids', () => {
        this.lmOrderMatcherRef!.matchAll();
      });
    }
  }

  async start(): Promise<void> {
    logger.info('Starting worker...');

    // Fetch initial meta + prices from HL HTTP API
    await this.seedMarketData();

    // Connect WebSocket and subscribe
    this.wsClient!.connect();
    this.wsClient!.subscribe({ type: 'allMids' });
    this.wsClient!.subscribe({ type: 'activeAssetCtx' });

    this.fundingWorker.start();

    if (config.LM_ENABLED) {
      await this.lmPriceUpdater!.seedMarkets();

      const marketsRaw: Record<string, string> = await redis.hgetall(KEYS.LM_MARKETS);
      const slugs = Object.keys(marketsRaw);

      await this.lmWsClient!.connect();
      await this.lmWsClient!.setMarketSlugs(slugs);
      this.lmPriceUpdater!.startPolling();
      this.lmResolver!.start();

      logger.info({ markets: slugs.length }, 'Limitless worker started');
    }

    logger.info('Worker started');
  }

  private async seedMarketData(): Promise<void> {
    try {
      // Fetch meta (universe info)
      const metaRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });
      const meta: HlMeta = await metaRes.json() as HlMeta;
      await redis.set(KEYS.MARKET_META, JSON.stringify(meta));
      logger.info({ assets: meta.universe.length }, 'Seeded market meta');

      // Fetch metaAndAssetCtxs for initial prices
      const ctxRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const ctxData = await ctxRes.json() as [HlMeta, HlAssetCtx[]];
      const assetCtxs = ctxData[1];

      // Build initial mids from the best live price available.
      const mids: Record<string, string> = {};
      for (let i = 0; i < meta.universe.length && i < assetCtxs.length; i++) {
        const coin = meta.universe[i].name;
        const ctx = assetCtxs[i];
        const livePx = ctx.midPx ?? ctx.markPx;
        if (livePx) {
          mids[coin] = livePx;
        }
        // Store asset context
        await redis.hset(KEYS.MARKET_CTX(coin),
          'markPx', ctx.markPx ?? '',
          'midPx', ctx.midPx ?? '',
          'oraclePx', ctx.oraclePx ?? '',
          'funding', ctx.funding ?? '',
          'openInterest', ctx.openInterest ?? '',
          'prevDayPx', ctx.prevDayPx ?? '',
          'dayNtlVlm', ctx.dayNtlVlm ?? '',
          'premium', ctx.premium ?? '',
        );
      }

      await this.priceUpdater.seedMids(mids);

      // Fetch allMids for current mid prices
      const midsRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      const allMids = await midsRes.json() as Record<string, string>;
      await this.priceUpdater.seedMids(allMids);
    } catch (err) {
      logger.error({ err }, 'Failed to seed market data');
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (config.LM_ENABLED) {
      this.lmResolver?.stop();
      this.lmPriceUpdater?.stopPolling();
      await this.lmWsClient?.close();
    }

    this.fundingWorker.stop();
    this.wsClient?.close();
    logger.info('Worker stopped');
  }
}
