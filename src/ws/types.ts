import type { PaperOrder, PaperFill } from '../types/order.js';
import type { LmPaperOrder, LmPaperFill } from '../types/limitless-order.js';

// === Inbound (client → server) ===

export interface WsSubscribeMessage {
  method: 'subscribe';
  subscription: WsSubscription;
}

export interface WsUnsubscribeMessage {
  method: 'unsubscribe';
  subscription: WsSubscription;
}

export type WsInboundMessage = WsSubscribeMessage | WsUnsubscribeMessage;

export type WsSubscription =
  | { type: 'allMids' }
  | { type: 'l2Book'; coin: string }
  | { type: 'orderUpdates'; user: string }
  | { type: 'userFills'; user: string }
  | { type: 'lmPrices' }
  | { type: 'lmOrderUpdates'; user: string }
  | { type: 'lmUserFills'; user: string };

// === Outbound (server → client) ===

export interface WsAllMidsMessage {
  channel: 'allMids';
  data: { mids: Record<string, string> };
}

export interface WsL2BookMessage {
  channel: 'l2Book';
  data: {
    coin: string;
    levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
    time: number;
  };
}

export interface WsOrderUpdateMessage {
  channel: 'orderUpdates';
  data: Array<{
    order: {
      coin: string;
      side: 'B' | 'A';
      limitPx: string;
      sz: string;
      oid: number;
      timestamp: number;
      origSz: string;
      cloid?: string;
    };
    status: string;
    statusTimestamp: number;
  }>;
}

export interface WsUserFillsMessage {
  channel: 'userFills';
  data: {
    isSnapshot: boolean;
    user: string;
    fills: PaperFill[];
  };
}

export interface WsLmPricesMessage {
  channel: 'lmPrices';
  data: { prices: Record<string, { yes: string; no: string }> };
}

export interface WsLmOrderUpdateMessage {
  channel: 'lmOrderUpdates';
  data: Array<{
    order: LmPaperOrder;
    status: string;
  }>;
}

export interface WsLmFillMessage {
  channel: 'lmUserFills';
  data: {
    isSnapshot: boolean;
    user: string;
    fills: LmPaperFill[];
  };
}

export type WsOutboundMessage =
  | WsAllMidsMessage
  | WsL2BookMessage
  | WsOrderUpdateMessage
  | WsUserFillsMessage
  | WsLmPricesMessage
  | WsLmOrderUpdateMessage
  | WsLmFillMessage;

// === Event bus payloads ===

export interface MidsEvent {
  mids: Record<string, string>;
}

export interface L2BookEvent {
  coin: string;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
  time: number;
}

export interface FillEvent {
  userId: string;
  fill: PaperFill;
}

export interface OrderUpdateEvent {
  userId: string;
  order: PaperOrder;
  status: string;
}

// Limitless event bus payloads
export interface LmMidsEvent {
  prices: Record<string, { yes: string; no: string }>;
}

export interface LmFillEvent {
  userId: string;
  fill: LmPaperFill;
}

export interface LmOrderUpdateEvent {
  userId: string;
  order: LmPaperOrder;
  status: string;
}

export interface FundingEvent {
  userId: string;
  coin: string;
  szi: string;
  fundingRate: string;
  fundingCharge: string;
  timestamp: number;
}
