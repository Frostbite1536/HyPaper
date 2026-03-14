import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type WsMessageHandler = (channel: string, data: unknown) => void;

export class HlWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectDelay: number;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: WsMessageHandler;
  private subscriptions: object[] = [];

  constructor(handler: WsMessageHandler) {
    this.handler = handler;
    this.reconnectDelay = config.WS_RECONNECT_MIN_MS;
  }

  connect(): void {
    logger.info({ url: config.HL_WS_URL }, 'Connecting to HL WebSocket');
    this.ws = new WebSocket(config.HL_WS_URL);

    this.ws.on('open', () => {
      logger.info('HL WebSocket connected');
      this.reconnectDelay = config.WS_RECONNECT_MIN_MS;
      this.sendSubscriptions();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel && msg.data) {
          this.handler(msg.channel, msg.data);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse WS message');
      }
    });

    this.ws.on('close', () => {
      logger.warn('HL WebSocket closed');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'HL WebSocket error');
    });
  }

  subscribe(subscription: object): void {
    this.subscriptions.push(subscription);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    }
  }

  private sendSubscriptions(): void {
    for (const sub of this.subscriptions) {
      this.ws?.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    logger.info({ delay: this.reconnectDelay }, 'Scheduling WS reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, config.WS_RECONNECT_MAX_MS);
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
