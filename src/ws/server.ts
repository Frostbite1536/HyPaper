import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { getLmOpenOrders } from '../engine/lm-position.js';
import { getLmUserFills } from '../engine/lm-fill.js';
import type {
  WsSubscription,
  MidsEvent,
  L2BookEvent,
  FillEvent,
  OrderUpdateEvent,
  FundingEvent,
  LmMidsEvent,
  LmFillEvent,
  LmOrderUpdateEvent,
} from './types.js';

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  isAlive: boolean;
}

const HEARTBEAT_INTERVAL = 30_000;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 50;

export class HyPaperWsServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private subscriptionIndex = new Map<string, Set<WebSocket>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private eventBus: EventEmitter;

  constructor(server: Server, eventBus: EventEmitter) {
    this.eventBus = eventBus;

    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      this.handleConnection(ws);
    });

    this.setupEventListeners();
    this.startHeartbeat();

    logger.info('WebSocket server attached at /ws');
  }

  private handleConnection(ws: WebSocket): void {
    const state: ClientState = {
      ws,
      subscriptions: new Set(),
      isAlive: true,
    };
    this.clients.set(ws, state);

    ws.on('pong', () => {
      state.isAlive = true;
    });

    ws.on('message', (raw: Buffer) => {
      this.handleMessage(state, raw).catch((err) => {
        logger.warn({ err }, 'WebSocket handleMessage error');
      });
    });

    ws.on('close', () => {
      this.handleDisconnect(state);
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'WebSocket client error');
      this.handleDisconnect(state);
    });
  }

  private async handleMessage(state: ClientState, raw: Buffer): Promise<void> {
    let msg: { method?: string; subscription?: WsSubscription };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.send(state.ws, { error: 'Invalid JSON' });
      return;
    }

    switch (msg.method) {
      case 'subscribe':
        if (msg.subscription) await this.handleSubscribe(state, msg.subscription);
        else this.send(state.ws, { error: 'Missing subscription' });
        break;
      case 'unsubscribe':
        if (msg.subscription) this.handleUnsubscribe(state, msg.subscription);
        else this.send(state.ws, { error: 'Missing subscription' });
        break;
      default:
        this.send(state.ws, { error: `Unknown method: ${msg.method}` });
    }
  }

  private async handleSubscribe(state: ClientState, sub: WsSubscription): Promise<void> {
    const key = this.subscriptionKey(sub);
    if (!key) {
      this.send(state.ws, { error: 'Invalid subscription' });
      return;
    }

    if (state.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      this.send(state.ws, { error: 'Too many subscriptions' });
      return;
    }

    state.subscriptions.add(key);
    if (!this.subscriptionIndex.has(key)) {
      this.subscriptionIndex.set(key, new Set());
    }
    this.subscriptionIndex.get(key)!.add(state.ws);

    this.send(state.ws, { channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: sub } });

    // Send snapshot for allMids
    if (sub.type === 'allMids') {
      const mids = await redis.hgetall(KEYS.MARKET_MIDS);
      if (Object.keys(mids).length > 0) {
        this.send(state.ws, { channel: 'allMids', data: { mids } });
      }
    }

    // Send snapshot for l2Book
    if (sub.type === 'l2Book') {
      const l2Raw = await redis.get(KEYS.MARKET_L2(sub.coin));
      if (l2Raw) {
        try {
          const l2 = JSON.parse(l2Raw);
          this.send(state.ws, { channel: 'l2Book', data: { coin: l2.coin, levels: l2.levels, time: l2.time } });
        } catch {
          logger.warn({ coin: sub.coin }, 'Corrupted L2 data in Redis, skipping snapshot');
        }
      }
    }

    // Send snapshot for lmPrices
    if (sub.type === 'lmPrices') {
      const pricesRaw: Record<string, string> = await redis.hgetall(KEYS.LM_MARKET_PRICES);
      if (Object.keys(pricesRaw).length > 0) {
        const parsed: Record<string, { yes: string; no: string }> = {};
        for (const [slug, json] of Object.entries(pricesRaw)) {
          try {
            parsed[slug] = JSON.parse(json);
          } catch { /* skip corrupted */ }
        }
        this.send(state.ws, { channel: 'lmPrices', data: { prices: parsed } });
      }
    }

    // Send snapshot for lmOrderUpdates
    if (sub.type === 'lmOrderUpdates' && sub.user) {
      const orders = await getLmOpenOrders(sub.user);
      if (orders.length > 0) {
        this.send(state.ws, {
          channel: 'lmOrderUpdates',
          data: orders.map((o) => ({ order: o, status: 'open' })),
        });
      }
    }

    // Send snapshot for lmUserFills
    if (sub.type === 'lmUserFills' && sub.user) {
      const fills = await getLmUserFills(sub.user, 50);
      if (fills.length > 0) {
        this.send(state.ws, {
          channel: 'lmUserFills',
          data: { isSnapshot: true, user: sub.user, fills },
        });
      }
    }
  }

  private handleUnsubscribe(state: ClientState, sub: WsSubscription): void {
    const key = this.subscriptionKey(sub);
    if (!key) return;

    state.subscriptions.delete(key);
    this.subscriptionIndex.get(key)?.delete(state.ws);

    this.send(state.ws, { channel: 'subscriptionResponse', data: { method: 'unsubscribe', subscription: sub } });
  }

  private handleDisconnect(state: ClientState): void {
    for (const key of state.subscriptions) {
      this.subscriptionIndex.get(key)?.delete(state.ws);
    }
    this.clients.delete(state.ws);
  }

  private subscriptionKey(sub: WsSubscription): string | null {
    switch (sub.type) {
      case 'allMids':
        return 'allMids';
      case 'l2Book':
        return sub.coin ? `l2Book:${sub.coin}` : null;
      case 'orderUpdates':
        return sub.user ? `orderUpdates:${sub.user}` : null;
      case 'userFills':
        return sub.user ? `userFills:${sub.user}` : null;
      case 'userFunding':
        return sub.user ? `userFunding:${sub.user}` : null;
      case 'lmPrices':
        return 'lmPrices';
      case 'lmOrderUpdates':
        return sub.user ? `lmOrderUpdates:${sub.user}` : null;
      case 'lmUserFills':
        return sub.user ? `lmUserFills:${sub.user}` : null;
      default:
        return null;
    }
  }

  private setupEventListeners(): void {
    this.eventBus.on('mids', (event: MidsEvent) => {
      const json = JSON.stringify({ channel: 'allMids', data: { mids: event.mids } });
      this.broadcast('allMids', json);
    });

    this.eventBus.on('l2book', (event: L2BookEvent) => {
      const json = JSON.stringify({
        channel: 'l2Book',
        data: { coin: event.coin, levels: event.levels, time: event.time },
      });
      this.broadcast(`l2Book:${event.coin}`, json);
    });

    this.eventBus.on('fill', (event: FillEvent) => {
      const json = JSON.stringify({
        channel: 'userFills',
        data: { isSnapshot: false, user: event.userId, fills: [event.fill] },
      });
      this.broadcast(`userFills:${event.userId}`, json);
    });

    this.eventBus.on('orderUpdate', (event: OrderUpdateEvent) => {
      const order = event.order;
      const json = JSON.stringify({
        channel: 'orderUpdates',
        data: [{
          order: {
            coin: order.coin,
            side: order.isBuy ? 'B' : 'A',
            limitPx: order.limitPx,
            sz: order.sz,
            oid: order.oid,
            timestamp: order.createdAt,
            origSz: order.sz,
            cloid: order.cloid,
          },
          status: event.status,
          statusTimestamp: order.updatedAt,
        }],
      });
      this.broadcast(`orderUpdates:${event.userId}`, json);
    });

    this.eventBus.on('funding', (event: FundingEvent) => {
      const json = JSON.stringify({
        channel: 'userFunding',
        data: {
          user: event.userId,
          coin: event.coin,
          szi: event.szi,
          fundingRate: event.fundingRate,
          fundingCharge: event.fundingCharge,
          timestamp: event.timestamp,
        },
      });
      this.broadcast(`userFunding:${event.userId}`, json);
    });

    // --- Limitless event listeners ---

    this.eventBus.on('lm:mids', (event: LmMidsEvent) => {
      const json = JSON.stringify({ channel: 'lmPrices', data: { prices: event.prices } });
      this.broadcast('lmPrices', json);
    });

    this.eventBus.on('lm:fill', (event: LmFillEvent) => {
      const json = JSON.stringify({
        channel: 'lmUserFills',
        data: { isSnapshot: false, user: event.userId, fills: [event.fill] },
      });
      this.broadcast(`lmUserFills:${event.userId}`, json);
    });

    this.eventBus.on('lm:orderUpdate', (event: LmOrderUpdateEvent) => {
      const json = JSON.stringify({
        channel: 'lmOrderUpdates',
        data: [{ order: event.order, status: event.status }],
      });
      this.broadcast(`lmOrderUpdates:${event.userId}`, json);
    });
  }

  private broadcast(key: string, json: string): void {
    const subs = this.subscriptionIndex.get(key);
    if (!subs || subs.size === 0) return;

    for (const ws of subs) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > 1024 * 1024) {
        logger.warn({ buffered: ws.bufferedAmount }, 'Client buffer critical, terminating');
        ws.terminate();
        continue;
      }
      ws.send(json);
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, state] of this.clients) {
        if (!state.isAlive) {
          ws.terminate();
          this.handleDisconnect(state);
          continue;
        }
        state.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [ws] of this.clients) {
      ws.terminate();
    }
    this.clients.clear();
    this.subscriptionIndex.clear();
    this.wss.close();
  }
}
