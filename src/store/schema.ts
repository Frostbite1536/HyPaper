import { pgTable, text, integer, bigint, boolean, index } from 'drizzle-orm/pg-core';

// ---------- Enums as text (matching TS union types) ----------

export const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  balance: text('balance').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const orders = pgTable('orders', {
  oid: integer('oid').primaryKey(),
  cloid: text('cloid'),
  userId: text('user_id').notNull().references(() => users.userId),
  asset: integer('asset').notNull(),
  coin: text('coin').notNull(),
  isBuy: boolean('is_buy').notNull(),
  sz: text('sz').notNull(),
  limitPx: text('limit_px').notNull(),
  orderType: text('order_type').notNull(), // 'limit' | 'trigger'
  tif: text('tif').notNull(), // 'Gtc' | 'Ioc' | 'Alo'
  reduceOnly: boolean('reduce_only').notNull(),
  triggerPx: text('trigger_px'),
  tpsl: text('tpsl'), // 'tp' | 'sl'
  isMarket: boolean('is_market'),
  grouping: text('grouping').notNull(), // 'na' | 'normalTpsl' | 'positionTpsl'
  status: text('status').notNull(), // 'open' | 'filled' | 'cancelled' | 'triggered' | 'rejected'
  filledSz: text('filled_sz').notNull(),
  avgPx: text('avg_px').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('orders_user_id_idx').on(table.userId),
  index('orders_user_id_status_idx').on(table.userId, table.status),
  index('orders_coin_idx').on(table.coin),
]);

export const fills = pgTable('fills', {
  tid: integer('tid').primaryKey(),
  userId: text('user_id').notNull().references(() => users.userId),
  oid: integer('oid').notNull().references(() => orders.oid),
  coin: text('coin').notNull(),
  px: text('px').notNull(),
  sz: text('sz').notNull(),
  side: text('side').notNull(), // 'B' | 'A'
  time: bigint('time', { mode: 'number' }).notNull(),
  startPosition: text('start_position').notNull(),
  dir: text('dir').notNull(),
  closedPnl: text('closed_pnl').notNull(),
  hash: text('hash').notNull(),
  crossed: boolean('crossed').notNull(),
  fee: text('fee').notNull(),
  cloid: text('cloid'),
  feeToken: text('fee_token').notNull(),
}, (table) => [
  index('fills_user_id_time_idx').on(table.userId, table.time),
  index('fills_oid_idx').on(table.oid),
]);

// ---------- Limitless Paper Trading Tables ----------

export const lmOrders = pgTable('lm_orders', {
  oid: integer('oid').primaryKey(),
  userId: text('user_id').notNull().references(() => users.userId),
  marketSlug: text('market_slug').notNull(),
  outcome: text('outcome').notNull(),           // 'yes' | 'no'
  side: text('side').notNull(),                 // 'buy' | 'sell'
  price: text('price').notNull(),               // decimal string
  size: text('size').notNull(),                 // decimal string
  orderType: text('order_type').notNull(),      // 'limit' | 'market'
  status: text('status').notNull(),             // 'open' | 'filled' | 'cancelled' | 'rejected'
  filledSize: text('filled_size').notNull(),
  avgFillPrice: text('avg_fill_price').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('lm_orders_user_id_idx').on(table.userId),
  index('lm_orders_user_id_status_idx').on(table.userId, table.status),
  index('lm_orders_market_slug_idx').on(table.marketSlug),
  index('lm_orders_market_slug_status_idx').on(table.marketSlug, table.status),
]);

export const lmFills = pgTable('lm_fills', {
  tid: integer('tid').primaryKey(),
  userId: text('user_id').notNull().references(() => users.userId),
  oid: integer('oid').references(() => lmOrders.oid),  // null for resolution fills
  marketSlug: text('market_slug').notNull(),
  outcome: text('outcome').notNull(),           // 'yes' | 'no'
  side: text('side').notNull(),                 // 'buy' | 'sell' | 'resolution'
  price: text('price').notNull(),
  size: text('size').notNull(),
  fee: text('fee').notNull(),
  closedPnl: text('closed_pnl').notNull(),
  time: bigint('time', { mode: 'number' }).notNull(),
}, (table) => [
  index('lm_fills_user_id_time_idx').on(table.userId, table.time),
  index('lm_fills_oid_idx').on(table.oid),
]);
