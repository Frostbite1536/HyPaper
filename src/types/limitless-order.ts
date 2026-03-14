export type LmOrderSide = 'buy' | 'sell';
export type LmFillSide = 'buy' | 'sell' | 'resolution';
export type LmOutcome = 'yes' | 'no';
export type LmOrderType = 'limit' | 'market';
export type LmOrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';

export interface LmPaperOrder {
  oid: number;                // from shared seq:oid sequence
  userId: string;             // wallet address (lowercased)
  marketSlug: string;         // e.g. "btc-100k-2024"
  outcome: LmOutcome;        // 'yes' or 'no'
  side: LmOrderSide;         // 'buy' or 'sell'
  price: string;              // decimal string 0.01-0.99
  size: string;               // number of shares (decimal string)
  orderType: LmOrderType;    // 'limit' (GTC) or 'market' (FOK)
  status: LmOrderStatus;
  filledSize: string;         // '0' initially
  avgFillPrice: string;       // '0' initially
  createdAt: number;          // Date.now() ms
  updatedAt: number;
}

export interface LmPaperFill {
  tid: number;                // from shared seq:tid sequence
  oid: number | null;         // null for resolution fills
  userId: string;
  marketSlug: string;
  outcome: LmOutcome;
  side: LmFillSide;
  price: string;              // fill price
  size: string;               // fill size
  fee: string;                // '0' (no fees for v1)
  closedPnl: string;          // realized PnL on sells
  time: number;               // Date.now() ms
}

export interface LmPaperPosition {
  userId: string;
  marketSlug: string;
  yesBalance: string;         // number of YES shares held
  noBalance: string;          // number of NO shares held
  yesCost: string;            // total USDC spent on YES shares
  noCost: string;             // total USDC spent on NO shares
  yesAvgPrice: string;        // weighted average entry price for YES
  noAvgPrice: string;         // weighted average entry price for NO
}
