import { EventEmitter } from 'node:events';
import { HttpClient, MarketFetcher } from '@limitless-exchange/sdk';
import type { Market } from '@limitless-exchange/sdk';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D } from '../utils/math.js';
import type { LmCachedMarket } from '../types/limitless.js';

export class LmPriceUpdater {
  private eventBus: EventEmitter;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private marketFetcher: MarketFetcher;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
    const httpClient = new HttpClient({ baseURL: config.LM_API_URL });
    this.marketFetcher = new MarketFetcher(httpClient);
  }

  async seedMarkets(): Promise<void> {
    let page = 1;
    let totalSeeded = 0;
    const allPrices: Record<string, { yes: string; no: string }> = {};

    // Paginate through all active markets
    while (true) {
      const response = await this.marketFetcher.getActiveMarkets({ limit: 25, page });
      if (response.data.length === 0) break;

      const pipeline = redis.pipeline();

      for (const market of response.data) {
        // Only support single CLOB markets that are funded
        if (market.tradeType !== 'clob' || market.status !== 'FUNDED') continue;

        const cached: LmCachedMarket = {
          slug: market.slug,
          title: market.title,
          status: market.status,
          expirationDate: market.expirationDate,
          positionIds: market.positionIds ?? [],
          winningOutcomeIndex: market.winningOutcomeIndex ?? null,
          marketType: market.marketType,
        };

        pipeline.hset(KEYS.LM_MARKETS, market.slug, JSON.stringify(cached));

        // Extract prices from market.prices array (prices[0] = YES, prices[1] = NO)
        if (market.prices && market.prices.length >= 2) {
          const yesPrice = this.clampPrice(market.prices[0]);
          const noPrice = this.clampPrice(market.prices[1]);
          const priceObj = { yes: yesPrice, no: noPrice };
          pipeline.hset(KEYS.LM_MARKET_PRICES, market.slug, JSON.stringify(priceObj));
          allPrices[market.slug] = priceObj;
        }

        totalSeeded++;
      }

      await pipeline.exec();

      if (response.data.length < 25) break;
      page++;
    }

    logger.info({ count: totalSeeded }, 'Seeded Limitless markets');

    if (Object.keys(allPrices).length > 0) {
      this.eventBus.emit('lm:mids', { prices: allPrices });
    }
  }

  startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.seedMarkets().catch((err) => {
        logger.error({ err }, 'LM price poll failed');
      });
    }, config.LM_POLL_INTERVAL_MS);
  }

  async handleOrderbookUpdate(
    slug: string,
    orderbook: { bids: Array<{ price: number; size: string }>; asks: Array<{ price: number; size: string }>; adjustedMidpoint?: number },
  ): Promise<void> {
    let yesPrice: string;

    if (orderbook.adjustedMidpoint != null) {
      yesPrice = this.clampPrice(orderbook.adjustedMidpoint);
    } else {
      const bestBid = orderbook.bids.length > 0 ? orderbook.bids[0].price : null;
      const bestAsk = orderbook.asks.length > 0 ? orderbook.asks[0].price : null;

      if (bestBid != null && bestAsk != null) {
        yesPrice = this.clampPrice(D(bestBid.toString()).plus(D(bestAsk.toString())).div(D('2')).toNumber());
      } else if (bestBid != null) {
        yesPrice = this.clampPrice(bestBid);
      } else if (bestAsk != null) {
        yesPrice = this.clampPrice(bestAsk);
      } else {
        return; // No price data
      }
    }

    const noPrice = D('1').minus(D(yesPrice)).toString();
    const priceObj = { yes: yesPrice, no: noPrice };

    await redis.hset(KEYS.LM_MARKET_PRICES, slug, JSON.stringify(priceObj));
    await redis.set(KEYS.LM_MARKET_ORDERBOOK(slug), JSON.stringify(orderbook));

    this.eventBus.emit('lm:mids', { prices: { [slug]: priceObj } });
  }

  async fetchOrderbook(slug: string): Promise<void> {
    try {
      const orderbook = await this.marketFetcher.getOrderBook(slug);
      await redis.set(KEYS.LM_MARKET_ORDERBOOK(slug), JSON.stringify(orderbook));

      if (orderbook.adjustedMidpoint != null) {
        const yesPrice = this.clampPrice(orderbook.adjustedMidpoint);
        const noPrice = D('1').minus(D(yesPrice)).toString();
        await redis.hset(KEYS.LM_MARKET_PRICES, slug, JSON.stringify({ yes: yesPrice, no: noPrice }));
      }
    } catch (err) {
      logger.warn({ err, slug }, 'Failed to fetch LM orderbook');
    }
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clampPrice(price: number): string {
    const clamped = Math.max(0.01, Math.min(0.99, price));
    return D(clamped.toString()).toDecimalPlaces(4).toString();
  }
}
