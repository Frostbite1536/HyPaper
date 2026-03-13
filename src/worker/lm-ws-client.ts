import { WebSocketClient } from '@limitless-exchange/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type LmWsMessageHandler = (event: string, data: unknown) => void;

export class LmWebSocketClientWrapper {
  private client: WebSocketClient;
  private handler: LmWsMessageHandler;
  private marketSlugs: string[] = [];

  constructor(handler: LmWsMessageHandler) {
    this.handler = handler;
    this.client = new WebSocketClient({
      url: config.LM_WS_URL,
      autoReconnect: true,
    });

    this.client.on('orderbookUpdate', (data) => {
      this.handler('orderbookUpdate', data);
    });

    this.client.on('newPriceData', (data) => {
      this.handler('newPriceData', data);
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    logger.info('Limitless WebSocket connected via SDK');
  }

  async setMarketSlugs(slugs: string[]): Promise<void> {
    // Unsubscribe old slugs if any
    if (this.marketSlugs.length > 0) {
      await this.client.unsubscribe('subscribe_market_prices', {
        marketSlugs: this.marketSlugs,
      });
    }
    this.marketSlugs = slugs;
    if (slugs.length > 0) {
      await this.client.subscribe('subscribe_market_prices', {
        marketSlugs: slugs,
      });
    }
  }

  async close(): Promise<void> {
    await this.client.disconnect();
  }
}
