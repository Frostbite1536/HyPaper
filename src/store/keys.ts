export const KEYS = {
  // Market data
  MARKET_MIDS: 'market:mids',
  MARKET_CTX: (coin: string) => `market:ctx:${coin}`,
  MARKET_L2: (coin: string) => `market:l2:${coin}`,
  MARKET_META: 'market:meta',

  // User account
  USER_ACCOUNT: (userId: string) => `user:${userId}:account`,
  USER_POSITIONS: (userId: string) => `user:${userId}:positions`,
  USER_POS: (userId: string, asset: number) => `user:${userId}:pos:${asset}`,
  USER_LEV: (userId: string, asset: number) => `user:${userId}:lev:${asset}`,
  USER_ORDERS: (userId: string) => `user:${userId}:orders`,
  USER_CLOIDS: (userId: string) => `user:${userId}:cloids`,
  USER_FILLS: (userId: string) => `user:${userId}:fills`,
  USER_FUNDINGS: (userId: string) => `user:${userId}:fundings`,

  // Orders
  ORDER: (oid: number) => `order:${oid}`,
  ORDERS_OPEN: 'orders:open',
  ORDERS_TRIGGERS: 'orders:triggers',

  // Active users (for funding)
  USERS_ACTIVE: 'users:active',

  // Sequences
  SEQ_OID: 'seq:oid',
  SEQ_TID: 'seq:tid',

  // Limitless market data
  LM_MARKETS: 'lm:markets',
  LM_MARKET_PRICES: 'lm:prices',
  LM_MARKET_ORDERBOOK: (slug: string) => `lm:ob:${slug}` as const,

  // Limitless user data
  LM_USER_ACCOUNT: (userId: string) => `lm:user:${userId}:account` as const,
  LM_USER_POSITIONS: (userId: string) => `lm:user:${userId}:positions` as const,
  LM_USER_POS: (userId: string, slug: string) => `lm:user:${userId}:pos:${slug}` as const,
  LM_USER_ORDERS: (userId: string) => `lm:user:${userId}:orders` as const,
  LM_USER_FILLS: (userId: string) => `lm:user:${userId}:fills` as const,
  LM_ORDER: (oid: number) => `lm:order:${oid}` as const,

  // Limitless order tracking
  LM_ORDERS_OPEN: 'lm:orders:open',

  // Limitless active users (for resolution polling)
  LM_USERS_ACTIVE: 'lm:users:active',
} as const;
