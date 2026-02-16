export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'triggered' | 'rejected';
export type OrderSide = 'buy' | 'sell';
export type TimeInForce = 'Gtc' | 'Ioc' | 'Alo';
export type TpSl = 'tp' | 'sl';

export interface PaperOrder {
  oid: number;
  cloid?: string;
  userId: string;
  asset: number;
  coin: string;
  isBuy: boolean;
  sz: string;         // original size
  limitPx: string;    // limit price
  orderType: 'limit' | 'trigger';
  tif: TimeInForce;
  reduceOnly: boolean;
  // trigger fields
  triggerPx?: string;
  tpsl?: TpSl;
  isMarket?: boolean;
  // grouping
  grouping: 'na' | 'normalTpsl' | 'positionTpsl';
  // status
  status: OrderStatus;
  filledSz: string;
  avgPx: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaperFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  cloid?: string;
  feeToken: string;
}
