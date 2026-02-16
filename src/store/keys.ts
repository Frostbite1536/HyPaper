export const KEYS = {
  // Market data
  MARKET_MIDS: 'market:mids',
  MARKET_CTX: (coin: string) => `market:ctx:${coin}`,
  MARKET_L2: (coin: string) => `market:l2:${coin}`,
  MARKET_META: 'market:meta',

  // Auth
  AUTH_APIKEYS: 'auth:apikeys',

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

  // Sequences
  SEQ_OID: 'seq:oid',
  SEQ_TID: 'seq:tid',
} as const;
