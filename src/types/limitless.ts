// Re-export SDK types we use throughout HyPaper
export type {
  MarketInterface as LmMarketInterface,
  OrderBook as LmOrderbook,
  OrderbookEntry as LmOrderbookLevel,
  OrderbookData as LmOrderbookData,
  ActiveMarketsResponse as LmActiveMarketsResponse,
  ActiveMarketsParams as LmActiveMarketsParams,
  Venue as LmVenue,
  CollateralToken as LmCollateralToken,
  WebSocketEvents as LmWsEvents,
  SubscriptionChannel as LmSubscriptionChannel,
  SubscriptionOptions as LmSubscriptionOptions,
  OrderbookUpdate as LmWsOrderbookUpdate,
  NewPriceData as LmWsPriceData,
} from '@limitless-exchange/sdk';

export {
  DEFAULT_API_URL as LM_DEFAULT_API_URL,
  DEFAULT_WS_URL as LM_DEFAULT_WS_URL,
  DEFAULT_CHAIN_ID as LM_DEFAULT_CHAIN_ID,
} from '@limitless-exchange/sdk';

// HyPaper-specific: simplified market snapshot stored in Redis
// This is a subset of SDK Market fields we cache for quick lookups
export interface LmCachedMarket {
  slug: string;
  title: string;
  status: string;                       // 'CREATED' | 'FUNDED' | 'RESOLVED' | 'DISPUTED'
  expirationDate: string;               // ISO 8601
  positionIds: string[];                // [YES_ID, NO_ID]
  winningOutcomeIndex: number | null;   // null = unresolved, 0 = YES, 1 = NO
  marketType: string;                   // 'single-clob', 'amm', 'group-negrisk'
}
