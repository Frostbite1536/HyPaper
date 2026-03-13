# Limitless Paper Trading Plan

## Goal

Add Limitless Prediction Market paper trading to HyPaper alongside the existing HyperLiquid perps paper trading. Users will be able to paper-trade YES/NO outcome tokens on Limitless markets using the same infrastructure (Redis state, Postgres persistence, WebSocket push, Hono API server).

**Non-goals:**
- No on-chain interaction (no EIP-712 signing, no wallet integration)
- No margin/leverage system (prediction markets are fully collateralized)
- No funding payments
- No trigger orders (TP/SL)
- No frontend/UI (backend API only, like existing HyPaper)

**Key dependency**: [`@limitless-exchange/sdk@1.0.3`](https://www.npmjs.com/package/@limitless-exchange/sdk/v/1.0.3) — the official TypeScript SDK for Limitless Exchange. We use it for:
- **Types**: `Market`, `OrderBook`, `OrderbookEntry`, `Venue`, `Side`, `OrderType`, `ActiveMarketsResponse`, `WebSocketEvents`, `SubscriptionChannel`, etc. — avoids redefining API response types
- **`MarketFetcher`**: `getActiveMarkets()`, `getMarket(slug)`, `getOrderBook(slug)` — fetching market data and orderbooks from the real Limitless API
- **`WebSocketClient`**: Socket.IO-based client with typed events, auto-reconnect, subscribe/unsubscribe — replaces the need for a custom WebSocket client
- **`HttpClient`**: Configured HTTP client with base URL and optional API key
- **Constants**: `DEFAULT_API_URL`, `DEFAULT_WS_URL`, `DEFAULT_CHAIN_ID`

We do **NOT** use the SDK's `OrderBuilder`, `OrderSigner`, or `OrderClient` classes — those handle real on-chain EIP-712 signed order submission, which paper trading doesn't need.

---

## System Invariants

These rules must always hold. Violations are bugs.

### INV-DATA-001: Decimal Precision

**Rule**: All monetary values (prices, sizes, balances, PnL) must use `string` representation and `decimal.js` for arithmetic. Never use JavaScript `number` for financial math.

**Rationale**: Floating-point errors cause balance drift over many trades.

**Enforcement**: Use the existing `src/utils/math.ts` helpers (`D()`, `add()`, `sub()`, `mul()`, `div()`, etc.) for all calculations. All Redis fields and Postgres columns storing money are `text` type.

### INV-DATA-002: Price Bounds

**Rule**: Limitless prices must always be in range `[0.01, 0.99]`. YES price + NO price = 1.00. Any price outside this range is invalid and must be rejected.

**Enforcement**: Validate in `lm-order.ts` before creating any order. Assert in price updater before writing to Redis.

### INV-DATA-003: Balance Consistency

**Rule**: A user's USDC balance can never go negative. A user's token balance can never go negative. BUY orders require `balance >= price * size`. SELL orders require `tokenBalance >= size`.

**Enforcement**: Check in `lm-order.ts` before fill execution. Use Redis pipeline for atomic position + balance updates.

### INV-DATA-004: Redis-Postgres Consistency

**Rule**: Redis is the source of truth for hot state. Postgres is append-only for historical records (fills, order snapshots). Postgres writes must never block the trading path.

**Enforcement**: Use the existing `pg-sink.ts` pattern — enqueue writes via `eventBus`, don't await them in the order path.

### INV-DATA-005: Key Namespace Isolation

**Rule**: All Limitless Redis keys must use the `lm:` prefix. Limitless code must never read or write HL-namespaced keys (e.g., `market:mids`, `order:*`). HL code must never read or write `lm:` keys.

**Enforcement**: All keys defined in `src/store/keys.ts`. Code review.

### INV-DATA-006: Order State Machine

**Rule**: Order status transitions are: `open` → `filled`, `open` → `cancelled`. No other transitions are valid. A filled or cancelled order must never be modified.

**Enforcement**: Check `status === 'open'` before any fill or cancel operation.

### INV-DATA-007: Position Round-Trip Integrity

**Rule**: All fields of `LmPaperPosition`, `LmPaperOrder`, and `LmPaperFill` must survive Redis read/write and Postgres insert/select without data loss. String decimal values must not be coerced to numbers during serialization.

**Enforcement**: All position fields stored as individual hash fields in Redis (not JSON blob). Postgres columns use `text` for decimal strings.

---

## Key Differences: HyperLiquid Perps vs Limitless Prediction Markets

| Aspect | HyperLiquid (existing) | Limitless (new) |
|---|---|---|
| **Asset model** | Perpetual futures identified by numeric `asset` index + `coin` name (e.g. `0` → `BTC`) | Binary outcome markets identified by `slug` (e.g. `btc-100k-2024`), each with YES/NO tokens identified by large integer `positionId`s |
| **Position model** | Signed size (`szi`) with leverage, margin, liquidation | Token balances (`yesBalance`, `noBalance`) — no leverage, no liquidation, prices capped 0.01–0.99 |
| **Order types** | Limit (GTC/IOC/ALO), trigger (TP/SL), with leverage | Limit (GTC) and Market (FOK) — no leverage, no trigger orders |
| **PnL** | Unrealized = `(markPx - entryPx) * szi`; funding payments | Unrealized = `(currentPrice - avgFillPrice) * tokenBalance`; no funding; resolved markets pay $1.00 or $0.00 |
| **Pricing source** | HL WebSocket `allMids` + `activeAssetCtx` channels | SDK `MarketFetcher.getActiveMarkets()` for price snapshots + SDK `WebSocketClient` for `orderbookUpdate` events |
| **Collateral** | Virtual USD balance with margin | Virtual USDC balance (no margin — full collateral per share) |
| **Market resolution** | N/A (perps don't expire) | Markets resolve to YES or NO; winning shares pay $1.00, losers pay $0.00 |

---

## Architecture

### Approach: Parallel Module Architecture

Add `lm-` prefixed files alongside the existing HL-focused code. The two exchange backends share Redis, Postgres, and the HTTP/WS server but have separate:
- Type definitions
- Engine logic (order placement, fill, position management)
- Worker (price feed, order matcher)
- API routes
- Redis key namespaces (HL uses `market:*`, `order:*`, `user:*`; Limitless uses `lm:*`)

### File Layout

```
src/
├── types/
│   ├── hl.ts                  # (existing, DO NOT MODIFY)
│   ├── order.ts               # (existing, DO NOT MODIFY)
│   ├── position.ts            # (existing, DO NOT MODIFY)
│   ├── limitless.ts           # NEW: Re-exports from @limitless-exchange/sdk + HyPaper-specific types
│   └── limitless-order.ts     # NEW: Limitless paper order/fill/position types
├── engine/
│   ├── order.ts               # (existing, DO NOT MODIFY)
│   ├── fill.ts                # (existing, DO NOT MODIFY)
│   ├── position.ts            # (existing, DO NOT MODIFY)
│   ├── margin.ts              # (existing, DO NOT MODIFY)
│   ├── lm-order.ts            # NEW: Limitless order placement + cancellation
│   ├── lm-fill.ts             # NEW: Limitless fill queries (from Postgres)
│   └── lm-position.ts         # NEW: Limitless portfolio view + open orders
├── worker/
│   ├── ws-client.ts           # (existing, DO NOT MODIFY)
│   ├── price-updater.ts       # (existing, DO NOT MODIFY)
│   ├── order-matcher.ts       # (existing, DO NOT MODIFY)
│   ├── funding-worker.ts      # (existing, DO NOT MODIFY)
│   ├── index.ts               # MODIFY: add conditional Limitless worker startup
│   ├── lm-ws-client.ts        # NEW: Thin wrapper around SDK WebSocketClient
│   ├── lm-price-updater.ts    # NEW: Limitless market data → Redis
│   ├── lm-order-matcher.ts    # NEW: Limitless order matching on price ticks
│   └── lm-resolver.ts         # NEW: Market resolution poller
├── api/
│   ├── server.ts              # MODIFY: conditionally mount Limitless routes
│   ├── routes/
│   │   ├── exchange.ts        # (existing, DO NOT MODIFY)
│   │   ├── info.ts            # (existing, DO NOT MODIFY)
│   │   ├── hypaper.ts         # (existing, DO NOT MODIFY)
│   │   ├── lm-exchange.ts     # NEW: Limitless trading endpoint
│   │   ├── lm-info.ts         # NEW: Limitless info/markets/portfolio endpoint
│   │   └── lm-hypaper.ts      # NEW: Limitless account admin (reset/setBalance)
│   └── middleware/
│       ├── auth.ts            # (existing, reuse ensureAccount)
│       └── rate-limit.ts      # (existing, reuse)
├── store/
│   ├── keys.ts                # MODIFY: add LM_ key namespace
│   ├── schema.ts              # MODIFY: add lm_orders and lm_fills tables
│   ├── pg-sink.ts             # MODIFY: add lm:fill and lm:orderUpdate handlers
│   ├── pg-queries.ts          # MODIFY: add Limitless fill query functions
│   ├── redis.ts               # (existing, DO NOT MODIFY)
│   └── db.ts                  # (existing, DO NOT MODIFY)
├── ws/
│   ├── server.ts              # MODIFY: add Limitless subscription types + event handlers
│   └── types.ts               # MODIFY: add Limitless WS types
├── utils/
│   ├── math.ts                # (existing, reuse all helpers)
│   ├── id.ts                  # (existing, reuse nextOid/nextTid)
│   ├── logger.ts              # (existing, reuse)
│   ├── slippage.ts            # (existing, DO NOT MODIFY — not used by Limitless)
│   └── l2-cache.ts            # (existing, DO NOT MODIFY)
├── __tests__/
│   ├── lm-order-matcher.test.ts  # NEW: Limitless order matching tests
│   ├── lm-order.test.ts          # NEW: Limitless order placement tests
│   └── lm-position.test.ts       # NEW: Limitless portfolio/PnL tests
├── config.ts                  # MODIFY: add LM_ env vars
└── index.ts                   # (existing, DO NOT MODIFY — Worker handles LM startup)
```

### Data Flow

```
Limitless REST API ─────────────────┐
  via SDK MarketFetcher             │
  (poll every LM_POLL_INTERVAL_MS)  │
                                    ▼
                              ┌──────────────┐
Limitless WebSocket ────────► │ LmPriceUpdater│ ──► Redis lm:prices
  via SDK WebSocketClient     │              │     Redis lm:markets
  orderbookUpdate events      └──────┬───────┘
                                     │ emit lm:mids
                                     ▼
                              ┌──────────────┐
                              │LmOrderMatcher│ ──► fills → Redis position/balance
                              │              │     emit lm:fill, lm:orderUpdate
                              └──────┬───────┘
                                     │
                        ┌────────────┼────────────┐
                        ▼            ▼            ▼
                   ┌─────────┐ ┌─────────┐ ┌──────────┐
                   │ pg-sink │ │ WS push │ │ REST API │
                   │ (async) │ │ to      │ │ queries  │
                   │         │ │ clients │ │          │
                   └─────────┘ └─────────┘ └──────────┘
```

---

## External Dependencies

| Dependency | Purpose | Failure Mode |
|---|---|---|
| `@limitless-exchange/sdk@1.0.3` | TypeScript SDK: `MarketFetcher`, `WebSocketClient`, `HttpClient`, types | N/A (local dependency) |
| Limitless REST API (`api.limitless.exchange`) | Market data, prices (accessed via SDK `MarketFetcher`) | Stale prices in Redis; orders won't match until prices resume |
| Limitless WebSocket (`ws.limitless.exchange`) | Real-time orderbook updates (accessed via SDK `WebSocketClient`) | Falls back to REST polling; prices update less frequently |
| Redis | Hot state (positions, orders, prices) | Application cannot start or process orders |
| PostgreSQL | Historical persistence (fills, order snapshots) | Orders still work (Redis primary); history queries fail |

---

## Implementation Steps

### Phase 1: Types, Config & SDK Installation

#### 1.0 — Install `@limitless-exchange/sdk`

```bash
npm install @limitless-exchange/sdk@1.0.3
```

This brings in the official Limitless Exchange TypeScript SDK which includes:
- `HttpClient` — HTTP client for REST API calls (wraps axios)
- `MarketFetcher` — typed methods: `getActiveMarkets()`, `getMarket(slug)`, `getOrderBook(slug)`
- `WebSocketClient` — Socket.IO client with typed events, auto-reconnect, `subscribe()`/`unsubscribe()`/`on()`
- `Market` class — market data with `slug`, `title`, `positionIds`, `venue`, `status`, `prices`, `tokens`, etc.
- Type exports: `OrderBook`, `OrderbookEntry`, `Venue`, `Side`, `OrderType`, `ActiveMarketsResponse`, `WebSocketEvents`, `SubscriptionChannel`, `SubscriptionOptions`, `WebSocketState`, `CollateralToken`, etc.
- Constants: `DEFAULT_API_URL`, `DEFAULT_WS_URL`, `DEFAULT_CHAIN_ID`

The SDK's transitive dependencies (`axios`, `socket.io-client`, `ethers`, `eventemitter3`) will be installed automatically. Note: `ethers` is only used by `OrderSigner`/`OrderBuilder` which we don't use, but it's harmless as a transitive dep.

#### 1.1 — `src/config.ts` — Add Limitless env vars

Add these fields to the existing `envSchema` z.object:

```ts
LM_API_URL: z.string().default('https://api.limitless.exchange'),
LM_WS_URL: z.string().default('wss://ws.limitless.exchange'),
LM_ENABLED: z.coerce.boolean().default(false),
LM_DEFAULT_BALANCE: z.coerce.number().default(10_000),
LM_POLL_INTERVAL_MS: z.coerce.number().default(30_000),
LM_RESOLVER_INTERVAL_MS: z.coerce.number().default(60_000),
```

**Pattern to follow**: Match the existing env var style — `z.coerce` for numbers/booleans, `z.string()` for URLs. No other changes to this file.

#### 1.2 — `src/types/limitless.ts` — Re-exports and thin wrappers over SDK types

Instead of redefining Limitless API response types, **re-export from the SDK** and add only HyPaper-specific aliases/helpers.

```ts
// Re-export SDK types we use throughout HyPaper
export type {
  Market as LmMarket,
  OrderBook as LmOrderbook,
  OrderbookEntry as LmOrderbookLevel,
  ActiveMarketsResponse as LmActiveMarketsResponse,
  ActiveMarketsParams as LmActiveMarketsParams,
  Venue as LmVenue,
  CollateralToken as LmCollateralToken,
  WebSocketEvents as LmWsEvents,
  SubscriptionChannel as LmSubscriptionChannel,
  SubscriptionOptions as LmSubscriptionOptions,
  OrderbookUpdate as LmWsOrderbookUpdate,
  NewPriceData as LmWsPriceData,
  MarketInterface as LmMarketInterface,
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
```

**Why**: The SDK's `Market` class (v1.0.3) already includes `slug`, `title`, `status`, `positionIds`, `venue`, `prices`, `winningOutcomeIndex`, `expirationDate`, etc. We avoid type drift by re-exporting rather than redefining.

#### 1.3 — `src/types/limitless-order.ts` — Paper trading types for Limitless

These are the **internal types** used by HyPaper's Limitless engine. They parallel the existing `PaperOrder`, `PaperFill`, and `PaperPosition` types but adapted for prediction market semantics.

```ts
export type LmOrderSide = 'buy' | 'sell';
export type LmOutcome = 'yes' | 'no';
export type LmOrderType = 'limit' | 'market';
export type LmOrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';

export interface LmPaperOrder {
  oid: number;                // from shared seq:oid sequence
  userId: string;             // wallet address (lowercased)
  marketSlug: string;         // e.g. "btc-100k-2024"
  outcome: LmOutcome;        // 'yes' or 'no'
  side: LmOrderSide;         // 'buy' or 'sell'
  price: string;              // decimal string 0.01–0.99
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
  oid: number;
  userId: string;
  marketSlug: string;
  outcome: LmOutcome;
  side: LmOrderSide;
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
```

**Verification**: After creating these files, run `npx tsc --noEmit` to confirm no type errors.

---

### Phase 2: Store Layer

#### 2.1 — `src/store/keys.ts` — Add Limitless Redis key namespace

Add these entries to the existing `KEYS` object. Do NOT modify any existing keys.

```ts
// Limitless market data
LM_MARKETS: 'lm:markets',                                          // Hash: slug → JSON(LmMarket)
LM_MARKET_PRICES: 'lm:prices',                                     // Hash: slug → JSON({yes: string, no: string})
LM_MARKET_ORDERBOOK: (slug: string) => `lm:ob:${slug}` as const,   // String: JSON(LmOrderbook)

// Limitless user data
LM_USER_ACCOUNT: (userId: string) => `lm:user:${userId}:account` as const,       // Hash: balance, createdAt
LM_USER_POSITIONS: (userId: string) => `lm:user:${userId}:positions` as const,   // Set of market slugs
LM_USER_POS: (userId: string, slug: string) => `lm:user:${userId}:pos:${slug}` as const,  // Hash: position fields
LM_USER_ORDERS: (userId: string) => `lm:user:${userId}:orders` as const,         // Sorted set: oid scored by createdAt
LM_USER_FILLS: (userId: string) => `lm:user:${userId}:fills` as const,           // List: JSON(LmPaperFill)
LM_ORDER: (oid: number) => `lm:order:${oid}` as const,                           // Hash: all order fields

// Limitless order tracking
LM_ORDERS_OPEN: 'lm:orders:open',                                  // Set of open oid strings

// Limitless active users (for resolution polling)
LM_USERS_ACTIVE: 'lm:users:active',                                // Set of userId strings
```

#### 2.2 — `src/store/schema.ts` — Add Limitless Postgres tables

Add these tables **after** the existing `fills` table definition. Do NOT modify existing tables.

```ts
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
]);

export const lmFills = pgTable('lm_fills', {
  tid: integer('tid').primaryKey(),
  userId: text('user_id').notNull().references(() => users.userId),
  oid: integer('oid').notNull().references(() => lmOrders.oid),
  marketSlug: text('market_slug').notNull(),
  outcome: text('outcome').notNull(),           // 'yes' | 'no'
  side: text('side').notNull(),                 // 'buy' | 'sell'
  price: text('price').notNull(),
  size: text('size').notNull(),
  fee: text('fee').notNull(),
  closedPnl: text('closed_pnl').notNull(),
  time: bigint('time', { mode: 'number' }).notNull(),
}, (table) => [
  index('lm_fills_user_id_time_idx').on(table.userId, table.time),
  index('lm_fills_oid_idx').on(table.oid),
]);
```

#### 2.3 — `src/store/pg-sink.ts` — Add Limitless event handlers

Add imports at the top of the file (after existing imports):

```ts
import { lmOrders, lmFills } from './schema.js'; // Add to existing schema import
import type { LmPaperOrder, LmPaperFill } from '../types/limitless-order.js';
```

Add to the existing `startPgSink(eventBus)` function, after the existing `orderUpdate` listener. Follow the exact same pattern — use `enqueueWrite()` for async writes.

```ts
// Inside startPgSink(), add these listeners after the existing HL listeners:

eventBus.on('lm:fill', (event: { userId: string; fill: LmPaperFill }) => {
  enqueueWrite(async () => {
    await db.insert(lmFills)
      .values({
        tid: event.fill.tid,
        userId: event.userId,
        oid: event.fill.oid,
        marketSlug: event.fill.marketSlug,
        outcome: event.fill.outcome,
        side: event.fill.side,
        price: event.fill.price,
        size: event.fill.size,
        fee: event.fill.fee,
        closedPnl: event.fill.closedPnl,
        time: event.fill.time,
      })
      .onConflictDoNothing();
  });
});

eventBus.on('lm:orderUpdate', (event: { userId: string; order: LmPaperOrder; status: string }) => {
  enqueueWrite(async () => {
    await db.insert(lmOrders)
      .values({
        oid: event.order.oid,
        userId: event.userId,
        marketSlug: event.order.marketSlug,
        outcome: event.order.outcome,
        side: event.order.side,
        price: event.order.price,
        size: event.order.size,
        orderType: event.order.orderType,
        status: event.order.status,
        filledSize: event.order.filledSize,
        avgFillPrice: event.order.avgFillPrice,
        createdAt: event.order.createdAt,
        updatedAt: event.order.updatedAt,
      })
      .onConflictDoUpdate({
        target: lmOrders.oid,
        set: {
          status: event.order.status,
          filledSize: event.order.filledSize,
          avgFillPrice: event.order.avgFillPrice,
          updatedAt: event.order.updatedAt,
        },
      });
  });
});
```

#### 2.4 — `src/store/pg-queries.ts` — Add Limitless fill query functions

Add imports at top (extend existing imports):

```ts
import { lmFills } from './schema.js'; // Add to existing schema import
import type { LmPaperFill } from '../types/limitless-order.js';
```

Add these functions. **Important**: Follow the existing pattern — use `rowToLmFill()` mapper (same as existing `rowToFill()`), don't cast directly:

```ts
export async function getLmUserFillsPg(userId: string, limit = 100): Promise<LmPaperFill[]> {
  const rows = await db
    .select()
    .from(lmFills)
    .where(eq(lmFills.userId, userId))
    .orderBy(desc(lmFills.time))
    .limit(limit);
  return rows.map(rowToLmFill);
}

export async function getLmUserFillsByTimePg(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<LmPaperFill[]> {
  const conditions = [eq(lmFills.userId, userId), gte(lmFills.time, startTime)];
  if (endTime !== undefined) {
    conditions.push(lte(lmFills.time, endTime));
  }
  const rows = await db
    .select()
    .from(lmFills)
    .where(and(...conditions))
    .orderBy(desc(lmFills.time));
  return rows.map(rowToLmFill);
}

function rowToLmFill(row: typeof lmFills.$inferSelect): LmPaperFill {
  return {
    tid: row.tid,
    oid: row.oid,
    userId: row.userId,
    marketSlug: row.marketSlug,
    outcome: row.outcome as 'yes' | 'no',
    side: row.side as 'buy' | 'sell',
    price: row.price,
    size: row.size,
    fee: row.fee,
    closedPnl: row.closedPnl,
    time: row.time,
  };
}
```

**Verification**: Run `npm run db:generate` to create the migration, then `npm run db:push` to apply.

---

### Phase 3: Market Data Worker

#### 3.1 — `src/worker/lm-price-updater.ts` — Limitless market data → Redis

**Responsibilities**:
- Seed market data on startup via SDK `MarketFetcher.getActiveMarkets()`
- Periodically refresh via REST polling (also through SDK)
- Handle WebSocket price/orderbook updates
- Emit `lm:mids` events on price changes

```ts
import { EventEmitter } from 'node:events';
import { HttpClient, MarketFetcher } from '@limitless-exchange/sdk';
import type { Market as LmMarket, OrderbookUpdate } from '@limitless-exchange/sdk';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { LmCachedMarket } from '../types/limitless.js';

export class LmPriceUpdater {
  private eventBus: EventEmitter;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private marketFetcher: MarketFetcher;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
    // Create SDK HttpClient (no API key needed for public market data)
    const httpClient = new HttpClient({ baseURL: config.LM_API_URL });
    this.marketFetcher = new MarketFetcher(httpClient);
  }

  async seedMarkets(): Promise<void> {
    // 1. Use SDK: const response = await this.marketFetcher.getActiveMarkets({ limit: 100 });
    //    The SDK returns ActiveMarketsResponse with { data: Market[], totalMarketsCount: number }
    //    Paginate if needed: pass { limit: 100, page: 2 } etc.
    // 2. For each market in response.data where market.marketType === 'single-clob'
    //    and market.status === 'FUNDED' (SDK Market class has these fields):
    //    a. Build LmCachedMarket from SDK Market fields:
    //       { slug: market.slug, title: market.title, status: market.status,
    //         expirationDate: market.expirationDate, positionIds: market.positionIds,
    //         winningOutcomeIndex: market.winningOutcomeIndex, marketType: market.marketType }
    //    b. Store in KEYS.LM_MARKETS hash (slug → JSON(LmCachedMarket))
    //    c. Store prices in KEYS.LM_MARKET_PRICES hash (slug → JSON({yes, no}))
    //       where yes/no come from market.prices array (prices[0] = YES, prices[1] = NO)
    //       or from market.tradePrices if available
    // 3. Log count of markets seeded
    // 4. Emit lm:mids with all slugs that have prices
  }

  startPolling(): void {
    // setInterval calling seedMarkets() every config.LM_POLL_INTERVAL_MS
    // This refreshes prices from REST for markets not covered by WebSocket
  }

  async handleOrderbookUpdate(slug: string, orderbook: { bids: Array<{price: number; size: string}>; asks: Array<{price: number; size: string}> }): Promise<void> {
    // 1. Compute yesPrice from best ask (lowest ask) or midpoint
    //    If bids and asks both exist: midpoint = (bestBid + bestAsk) / 2
    //    If only bids: yesPrice = bestBid
    //    If only asks: yesPrice = bestAsk
    // 2. noPrice = 1 - yesPrice (enforce INV-DATA-002)
    // 3. Update KEYS.LM_MARKET_PRICES hash
    // 4. Store full orderbook at KEYS.LM_MARKET_ORDERBOOK(slug)
    // 5. Emit lm:mids event
  }

  // Fetch orderbook for a specific market using SDK
  async fetchOrderbook(slug: string): Promise<void> {
    // const orderbook = await this.marketFetcher.getOrderBook(slug);
    // SDK returns OrderBook with { adjustedMidpoint, bids, asks }
    // Use adjustedMidpoint directly if available
    // Store in Redis
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
```

**Key detail**: When computing prices from orderbook updates, always store as **string** decimals using `D()` from `math.ts`. Example: `D(bestBid).plus(D(bestAsk)).div(D('2')).toString()`.

#### 3.2 — `src/worker/lm-ws-client.ts` — Thin wrapper around SDK `WebSocketClient`

**No new dependency needed**: The SDK (`@limitless-exchange/sdk`) already includes `socket.io-client` as a transitive dependency and provides a typed `WebSocketClient` class with auto-reconnect, subscribe/unsubscribe, and typed event handlers.

```ts
import { WebSocketClient } from '@limitless-exchange/sdk';
import type { WebSocketEvents, SubscriptionChannel } from '@limitless-exchange/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type LmWsMessageHandler = (event: string, data: unknown) => void;

export class LmWebSocketClientWrapper {
  private client: WebSocketClient;
  private handler: LmWsMessageHandler;
  private marketSlugs: string[] = [];

  constructor(handler: LmWsMessageHandler) {
    this.handler = handler;
    // SDK WebSocketClient handles reconnection internally (autoReconnect: true)
    this.client = new WebSocketClient({
      url: config.LM_WS_URL,
      autoReconnect: true,
    });

    // Register typed event handlers using SDK's .on() method
    // SDK events: 'orderbookUpdate', 'newPriceData', 'error', 'connect', 'disconnect'
    this.client.on('orderbookUpdate', (data) => {
      this.handler('orderbookUpdate', data);
    });
    this.client.on('newPriceData', (data) => {
      this.handler('newPriceData', data);
    });
  }

  async connect(): Promise<void> {
    // SDK's connect() returns a Promise that resolves when connected
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
      // SDK's subscribe() emits the right Socket.IO event with typed options
      await this.client.subscribe('subscribe_market_prices', {
        marketSlugs: slugs,
      });
    }
  }

  // Note: close() is fire-and-forget from Worker.stop() which is sync.
  // Making this async so callers CAN await if they choose to.
  async close(): Promise<void> {
    await this.client.disconnect();
  }
}
```

**Key advantage**: The SDK `WebSocketClient` handles reconnection with exponential backoff, resubscription after reconnect, and typed event payloads automatically. We don't need to implement any of this ourselves.

#### 3.3 — `src/worker/lm-order-matcher.ts` — Order matching on price ticks

**Pattern to follow**: Model after the existing `OrderMatcher` class but simplified for prediction markets (no triggers, no slippage model).

```ts
import { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { D, sub, mul, add, isZero, gt, lt, lte, gte, abs, div, neg } from '../utils/math.js';
import { nextTid } from '../utils/id.js';
import type { LmPaperOrder, LmPaperFill } from '../types/limitless-order.js';

export class LmOrderMatcher {
  private isRunning = false;
  private eventBus: EventEmitter;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
  }

  async matchAll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.matchOpenOrders();
    } catch (err) {
      logger.error({ err }, 'LM order matcher error');
    } finally {
      this.isRunning = false;
    }
  }

  private async matchOpenOrders(): Promise<void> {
    // 1. Get all oids from KEYS.LM_ORDERS_OPEN set
    // 2. If empty, return
    // 3. For each oid:
    //    a. Read order hash from KEYS.LM_ORDER(oid)
    //    b. Parse into LmPaperOrder
    //    c. If status !== 'open', remove from set, continue
    //    d. Read current prices from KEYS.LM_MARKET_PRICES for order.marketSlug
    //    e. Get relevant price: order.outcome === 'yes' ? yesPrice : noPrice
    //    f. Check fill condition:
    //       - BUY: fill when currentPrice <= order.price
    //       - SELL: fill when currentPrice >= order.price
    //    g. If should fill: call executeFill(order, order.price)
    //       Fill at the limit price (not market price) since it's the better price for the user
  }

  async executeFill(order: LmPaperOrder, fillPrice: string): Promise<void> {
    // 1. Read current position from KEYS.LM_USER_POS(userId, marketSlug)
    // 2. Calculate fill size = order.size - order.filledSize
    // 3. If BUY:
    //    a. cost = fillPrice * fillSize
    //    b. Deduct cost from balance: redis.hincrbyfloat(LM_USER_ACCOUNT, 'balance', neg(cost))
    //    c. Add fillSize to position's yesBalance or noBalance
    //    d. Update weighted average entry price:
    //       newAvgPrice = (oldCost + cost) / (oldBalance + fillSize)
    //    e. Update yesCost/noCost: add cost
    // 4. If SELL:
    //    a. proceeds = fillPrice * fillSize
    //    b. Credit proceeds to balance
    //    c. Subtract fillSize from token balance
    //    d. Calculate realized PnL: (fillPrice - avgEntryPrice) * fillSize
    //    e. Update cost basis proportionally: cost -= avgEntryPrice * fillSize
    // 5. Atomic Redis pipeline:
    //    - Update position hash (or delete if both balances zero)
    //    - Update/remove from LM_USER_POSITIONS set
    //    - Mark order filled
    //    - Remove from LM_ORDERS_OPEN
    //    - Push fill to LM_USER_FILLS list
    //    - Add to LM_USERS_ACTIVE
    // 6. Emit 'lm:fill' and 'lm:orderUpdate' events
  }

  // Helper to parse order from Redis hash
  private parseOrder(data: Record<string, string>): LmPaperOrder {
    return {
      oid: parseInt(data.oid, 10),
      userId: data.userId,
      marketSlug: data.marketSlug,
      outcome: data.outcome as 'yes' | 'no',
      side: data.side as 'buy' | 'sell',
      price: data.price,
      size: data.size,
      orderType: data.orderType as 'limit' | 'market',
      status: data.status as LmPaperOrder['status'],
      filledSize: data.filledSize ?? '0',
      avgFillPrice: data.avgFillPrice ?? '0',
      createdAt: parseInt(data.createdAt, 10),
      updatedAt: parseInt(data.updatedAt, 10),
    };
  }
}
```

#### 3.4 — `src/worker/lm-resolver.ts` — Market resolution poller

```ts
import { EventEmitter } from 'node:events';
import { HttpClient, MarketFetcher } from '@limitless-exchange/sdk';
import type { Market as LmMarket } from '@limitless-exchange/sdk';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D, add, isZero } from '../utils/math.js';

export class LmResolver {
  private eventBus: EventEmitter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private marketFetcher: MarketFetcher;

  constructor(eventBus: EventEmitter) {
    this.eventBus = eventBus;
    const httpClient = new HttpClient({ baseURL: config.LM_API_URL });
    this.marketFetcher = new MarketFetcher(httpClient);
  }

  start(): void {
    this.timer = setInterval(() => this.checkResolutions(), config.LM_RESOLVER_INTERVAL_MS);
  }

  private async checkResolutions(): Promise<void> {
    // 1. Get all active users from KEYS.LM_USERS_ACTIVE
    // 2. For each user, get their position slugs from KEYS.LM_USER_POSITIONS
    // 3. Collect unique slugs across all users
    // 4. For each slug, use SDK: const market = await this.marketFetcher.getMarket(slug)
    //    SDK Market class has `winningOutcomeIndex` field (number | null)
    // 5. If market.winningOutcomeIndex is not null (market resolved):
    //    a. winningOutcomeIndex === 0 means YES wins, 1 means NO wins
    //    b. For each user with a position in this market:
    //       - Read position from Redis
    //       - winningBalance = (winning_index === 0) ? yesBalance : noBalance
    //       - Credit balance += winningBalance (each winning share pays $1.00)
    //       - Delete position from Redis
    //       - Remove slug from user's LM_USER_POSITIONS set
    //       - Create a fill record for the resolution
    //       - Emit 'lm:resolution' event
    //    c. Remove market from KEYS.LM_MARKETS hash
    //    d. Remove from KEYS.LM_MARKET_PRICES hash
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

---

### Phase 4: Engine

#### 4.1 — `src/engine/lm-order.ts` — Order placement + cancellation

**Pattern to follow**: Model after `src/engine/order.ts` but much simpler (no trigger orders, no margin, no leverage, no IOC/ALO). Use the same `nextOid()` from `utils/id.ts`.

```ts
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D, lte, gte, isZero, gt, lt, sub, mul } from '../utils/math.js';
import { nextOid } from '../utils/id.js';
import { eventBus } from '../worker/index.js';
import { LmOrderMatcher } from '../worker/lm-order-matcher.js';
import { upsertUser } from '../store/pg-sink.js';
import type { LmPaperOrder } from '../types/limitless-order.js';

// Create a local matcher instance — same pattern as src/engine/order.ts line 13
const matcher = new LmOrderMatcher(eventBus);

// LM accounts: creates Redis LM account state AND upserts into PG `users` table
// (needed because lm_orders/lm_fills have FK to users.userId)

export async function ensureLmAccount(userId: string): Promise<void> {
  const exists = await redis.exists(KEYS.LM_USER_ACCOUNT(userId));
  if (!exists) {
    await redis.hset(KEYS.LM_USER_ACCOUNT(userId),
      'userId', userId,
      'balance', config.LM_DEFAULT_BALANCE.toString(),
      'createdAt', Date.now().toString(),
    );
    // Also upsert into PG users table (needed for FK constraints on lm_orders/lm_fills)
    // Uses fire-and-forget pattern from pg-sink.ts — same as existing ensureAccount in auth.ts
    upsertUser(userId, config.LM_DEFAULT_BALANCE.toString());
  }
}

export async function placeLmOrder(
  userId: string,
  marketSlug: string,
  outcome: 'yes' | 'no',
  side: 'buy' | 'sell',
  price: string,
  size: string,
  orderType: 'limit' | 'market',
): Promise<{ status: 'ok'; oid: number } | { status: 'error'; message: string }> {
  // 1. VALIDATE MARKET EXISTS
  //    Read market from KEYS.LM_MARKETS hash
  //    Parse JSON, check status === 'FUNDED'
  //    If not found or not funded: return error

  // 2. VALIDATE PRICE (INV-DATA-002)
  //    const pxNum = Number(price);
  //    if (isNaN(pxNum) || pxNum < 0.01 || pxNum > 0.99) return error
  //    Also validate size > 0

  // 3. VALIDATE BALANCE (INV-DATA-003)
  //    If side === 'buy':
  //      cost = mul(price, size)
  //      balance = await redis.hget(KEYS.LM_USER_ACCOUNT(userId), 'balance')
  //      if lt(balance, cost): return error 'Insufficient balance'
  //    If side === 'sell':
  //      Read position from KEYS.LM_USER_POS(userId, marketSlug)
  //      tokenBalance = outcome === 'yes' ? pos.yesBalance : pos.noBalance
  //      if lt(tokenBalance, size): return error 'Insufficient tokens'

  // 4. CREATE ORDER
  //    const oid = await nextOid();
  //    Build LmPaperOrder object
  //    Save to KEYS.LM_ORDER(oid) as Redis hash
  //    Add to KEYS.LM_USER_ORDERS(userId) sorted set

  // 5. ATTEMPT IMMEDIATE FILL (for both market and limit orders)
  //    Read current price from KEYS.LM_MARKET_PRICES
  //    const currentPrice = outcome === 'yes' ? prices.yes : prices.no
  //    For MARKET orders: always attempt fill at current price, reject if no price
  //    For LIMIT orders:
  //      BUY: fill if currentPrice <= order.price (fill at order.price — better for user)
  //      SELL: fill if currentPrice >= order.price (fill at order.price)

  // 6. IF FILLS:
  //    Call matcher.executeFill(order, fillPrice)
  //    Return { status: 'ok', oid, filled: true }

  // 7. IF MARKET ORDER AND CAN'T FILL:
  //    Mark order as rejected
  //    Return error 'Market order could not be filled'

  // 8. IF LIMIT ORDER AND DOESN'T FILL:
  //    Add oid to KEYS.LM_ORDERS_OPEN set
  //    Emit 'lm:orderUpdate' event with status 'open'
  //    Return { status: 'ok', oid, filled: false }
}

export async function cancelLmOrder(
  userId: string,
  oid: number,
): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
  // 1. Read order from KEYS.LM_ORDER(oid)
  // 2. Verify orderData.userId === userId
  // 3. Verify orderData.status === 'open' (INV-DATA-006)
  // 4. Pipeline:
  //    - hset status = 'cancelled', updatedAt = now
  //    - srem from KEYS.LM_ORDERS_OPEN
  // 5. Emit 'lm:orderUpdate' event with status 'cancelled'
}

export async function cancelAllLmOrders(
  userId: string,
  marketSlug: string,
): Promise<{ cancelled: number }> {
  // 1. Get all oids from KEYS.LM_USER_ORDERS(userId)
  // 2. For each, read order, check marketSlug matches and status === 'open'
  // 3. Cancel matching orders (same as cancelLmOrder but batched in pipeline)
}
```

#### 4.2 — `src/engine/lm-fill.ts` — Fill queries (from Postgres)

```ts
import { getLmUserFillsPg, getLmUserFillsByTimePg } from '../store/pg-queries.js';
import type { LmPaperFill } from '../types/limitless-order.js';

export async function getLmUserFills(userId: string, limit = 100): Promise<LmPaperFill[]> {
  return getLmUserFillsPg(userId, limit);
}

export async function getLmUserFillsByTime(
  userId: string,
  startTime: number,
  endTime?: number,
): Promise<LmPaperFill[]> {
  return getLmUserFillsByTimePg(userId, startTime, endTime);
}
```

#### 4.3 — `src/engine/lm-position.ts` — Portfolio view + open orders

```ts
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, isZero } from '../utils/math.js';
import type { LmPaperPosition, LmPaperOrder } from '../types/limitless-order.js';

export interface LmPortfolioPosition {
  marketSlug: string;
  marketTitle: string;
  deadline: string;
  yesBalance: string;
  noBalance: string;
  yesCost: string;
  noCost: string;
  yesAvgPrice: string;
  noAvgPrice: string;
  currentYesPrice: string;
  currentNoPrice: string;
  yesUnrealizedPnl: string;
  noUnrealizedPnl: string;
  totalUnrealizedPnl: string;
  totalMarketValue: string;
}

export interface LmPortfolio {
  balance: string;
  totalUnrealizedPnl: string;
  totalMarketValue: string;
  accountValue: string;      // balance + totalUnrealizedPnl
  positions: LmPortfolioPosition[];
}

export async function getLmPortfolio(userId: string): Promise<LmPortfolio> {
  // 1. Read balance from KEYS.LM_USER_ACCOUNT
  // 2. Read all position slugs from KEYS.LM_USER_POSITIONS
  // 3. For each slug:
  //    a. Read position from KEYS.LM_USER_POS
  //    b. Read current prices from KEYS.LM_MARKET_PRICES
  //    c. Read market metadata from KEYS.LM_MARKETS (title, deadline)
  //    d. Calculate unrealized PnL:
  //       yesUnrealizedPnl = (currentYesPrice - yesAvgPrice) * yesBalance
  //       noUnrealizedPnl = (currentNoPrice - noAvgPrice) * noBalance
  //       (use D() for all arithmetic)
  //    e. Market value = (yesBalance * currentYesPrice) + (noBalance * currentNoPrice)
  // 4. Sum all unrealized PnL and market values
  // 5. accountValue = balance + totalUnrealizedPnl
  // 6. Return LmPortfolio
}

export async function getLmOpenOrders(userId: string): Promise<LmPaperOrder[]> {
  // 1. Get all oids from KEYS.LM_USER_ORDERS sorted set
  // 2. For each, read from KEYS.LM_ORDER(oid)
  // 3. Filter where status === 'open'
  // 4. Return as LmPaperOrder[]
}

export async function getLmBalance(userId: string): Promise<string> {
  const balance = await redis.hget(KEYS.LM_USER_ACCOUNT(userId), 'balance');
  return balance ?? '0';
}
```

---

### Phase 5: API Routes

#### 5.1 — `src/api/routes/lm-exchange.ts` — Trading endpoint

**Pattern to follow**: Model after `src/api/routes/exchange.ts`.

```ts
import { Hono } from 'hono';
import { placeLmOrder, cancelLmOrder, cancelAllLmOrders, ensureLmAccount } from '../../engine/lm-order.js';
import { logger } from '../../utils/logger.js';

export const lmExchangeRouter = new Hono();

lmExchangeRouter.post('/', async (c) => {
  const body = await c.req.json();

  const rawWallet: string | undefined = body.wallet;
  if (!rawWallet || typeof rawWallet !== 'string') {
    return c.json({ status: 'err', response: 'Missing wallet address' }, 400);
  }
  const wallet = rawWallet.toLowerCase();
  await ensureLmAccount(wallet);

  const action = body.action;
  if (!action || typeof action !== 'object' || !action.type) {
    return c.json({ status: 'err', response: 'Missing or invalid action' }, 400);
  }

  try {
    switch (action.type) {
      case 'order': {
        // Validate required fields: marketSlug (string), outcome ('yes'|'no'),
        // side ('buy'|'sell'), price (string), size (string), orderType ('limit'|'market')
        // Return 400 for any missing/invalid fields
        const result = await placeLmOrder(
          wallet, action.marketSlug, action.outcome,
          action.side, action.price, action.size, action.orderType,
        );
        if (result.status === 'error') {
          return c.json({ status: 'err', response: result.message }, 400);
        }
        return c.json({ status: 'ok', response: { oid: result.oid } });
      }

      case 'cancel': {
        // Validate: orderId (number)
        const result = await cancelLmOrder(wallet, action.orderId);
        if (result.status === 'error') {
          return c.json({ status: 'err', response: result.message }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'cancel' } });
      }

      case 'cancelAll': {
        // Validate: marketSlug (string)
        const result = await cancelAllLmOrders(wallet, action.marketSlug);
        return c.json({ status: 'ok', response: { cancelled: result.cancelled } });
      }

      default:
        return c.json({ status: 'err', response: `Unsupported action type: ${action.type}` }, 400);
    }
  } catch (err) {
    logger.error({ err, action: action.type }, 'LM exchange error');
    return c.json({ status: 'err', response: String(err) }, 500);
  }
});
```

#### 5.2 — `src/api/routes/lm-info.ts` — Info/query endpoint

**Pattern to follow**: Model after `src/api/routes/info.ts`.

```ts
import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { getLmPortfolio, getLmOpenOrders, getLmBalance } from '../../engine/lm-position.js';
import { getLmUserFills, getLmUserFillsByTime } from '../../engine/lm-fill.js';
import { ensureLmAccount } from '../../engine/lm-order.js';
import { logger } from '../../utils/logger.js';

export const lmInfoRouter = new Hono();

lmInfoRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user?.toLowerCase();

  if (!type) return c.json({ error: 'Missing type' }, 400);

  try {
    switch (type) {
      case 'markets': {
        // Return all active markets from KEYS.LM_MARKETS hash
        // Parse each JSON value and include current prices from KEYS.LM_MARKET_PRICES
        const marketsRaw = await redis.hgetall(KEYS.LM_MARKETS);
        const pricesRaw = await redis.hgetall(KEYS.LM_MARKET_PRICES);
        const markets = Object.entries(marketsRaw).map(([slug, json]) => {
          const market = JSON.parse(json);
          const prices = pricesRaw[slug] ? JSON.parse(pricesRaw[slug]) : null;
          return { ...market, currentPrices: prices };
        });
        return c.json({ markets });
      }

      case 'market': {
        // Single market by slug
        if (!body.slug) return c.json({ error: 'Missing slug' }, 400);
        const raw = await redis.hget(KEYS.LM_MARKETS, body.slug);
        if (!raw) return c.json({ error: 'Market not found' }, 404);
        const prices = await redis.hget(KEYS.LM_MARKET_PRICES, body.slug);
        return c.json({ ...JSON.parse(raw), currentPrices: prices ? JSON.parse(prices) : null });
      }

      case 'orderbook': {
        if (!body.slug) return c.json({ error: 'Missing slug' }, 400);
        const raw = await redis.get(KEYS.LM_MARKET_ORDERBOOK(body.slug));
        return c.json(raw ? JSON.parse(raw) : { bids: [], asks: [], adjustedMidpoint: null });
      }

      case 'portfolio': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        await ensureLmAccount(user);
        const portfolio = await getLmPortfolio(user);
        return c.json(portfolio);
      }

      case 'openOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        await ensureLmAccount(user);
        const orders = await getLmOpenOrders(user);
        return c.json(orders);
      }

      case 'userFills': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getLmUserFills(user));
      }

      case 'userFillsByTime': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        return c.json(await getLmUserFillsByTime(user, body.startTime ?? 0, body.endTime));
      }

      case 'balance': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        await ensureLmAccount(user);
        const balance = await getLmBalance(user);
        return c.json({ balance });
      }

      default:
        return c.json({ error: `Unknown type: ${type}` }, 400);
    }
  } catch (err) {
    logger.error({ err, type }, 'LM info error');
    return c.json({ error: String(err) }, 500);
  }
});
```

#### 5.3 — `src/api/server.ts` — Mount new routes

**Important**: `server.ts` is synchronous — no `async`/`await`, no dynamic `import()`. All imports are top-level static imports. Follow the exact same pattern:

Add imports at the top of the file (after existing route imports):

```ts
import { config } from '../config.js';
import { lmExchangeRouter } from './routes/lm-exchange.js';
import { lmInfoRouter } from './routes/lm-info.js';
```

Add route mounting after the existing routes, before the file ends:

```ts
// Limitless routes (conditional on LM_ENABLED)
if (config.LM_ENABLED) {
  app.get('/limitless/exchange', (c) => c.json(postOnlyMsg, 405));
  app.get('/limitless/info', (c) => c.json(postOnlyMsg, 405));
  app.use('/limitless/exchange', rateLimitMiddleware);
  app.use('/limitless/info', rateLimitMiddleware);
  app.route('/limitless/exchange', lmExchangeRouter);
  app.route('/limitless/info', lmInfoRouter);
}
```

Also update the root endpoint's `endpoints` array to include `/limitless/exchange`, `/limitless/info`, and `/limitless/hypaper` when `LM_ENABLED`.

#### 5.4 — `src/api/routes/lm-hypaper.ts` — Admin endpoint for LM accounts

**Pattern to follow**: Model after `src/api/routes/hypaper.ts`. Provides resetAccount, setBalance, getAccountInfo for LM paper trading accounts.

```ts
import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { ensureLmAccount } from '../../engine/lm-order.js';
import { upsertUser, updateUserBalance } from '../../store/pg-sink.js';

export const lmHypaperRouter = new Hono();

lmHypaperRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user;

  if (!type) return c.json({ error: 'Missing type' }, 400);
  if (!user || typeof user !== 'string') return c.json({ error: 'Missing user' }, 400);
  const normalizedUser = user.toLowerCase();
  await ensureLmAccount(normalizedUser);

  try {
    switch (type) {
      case 'resetAccount': {
        // 1. Get all position slugs from KEYS.LM_USER_POSITIONS
        // 2. Pipeline: delete each position hash, delete positions set
        // 3. Cancel all open orders (get from LM_USER_ORDERS sorted set)
        //    For each: hset status=cancelled, srem from LM_ORDERS_OPEN
        // 4. Delete: LM_USER_ORDERS, LM_USER_FILLS
        // 5. Reset balance to LM_DEFAULT_BALANCE
        // 6. Fire-and-forget upsertUser to Postgres
        return c.json({ status: 'ok', message: 'LM account reset' });
      }

      case 'setBalance': {
        // Validate body.balance is a number
        // hset LM_USER_ACCOUNT balance
        // Fire-and-forget updateUserBalance to Postgres
        return c.json({ status: 'ok', balance: body.balance.toString() });
      }

      case 'getAccountInfo': {
        const account = await redis.hgetall(KEYS.LM_USER_ACCOUNT(normalizedUser));
        return c.json({
          userId: account.userId,
          balance: account.balance,
          createdAt: parseInt(account.createdAt, 10),
        });
      }

      default:
        return c.json({ error: `Unknown type: ${type}` }, 400);
    }
  } catch (err) {
    logger.error({ err, type }, 'LM hypaper error');
    return c.json({ error: String(err) }, 500);
  }
});
```

Mount in `server.ts` inside the `if (config.LM_ENABLED)` block:

```ts
import { lmHypaperRouter } from './routes/lm-hypaper.js';
// ...
app.get('/limitless/hypaper', (c) => c.json(postOnlyMsg, 405));
app.use('/limitless/hypaper', rateLimitMiddleware);
app.route('/limitless/hypaper', lmHypaperRouter);
```

---

### Phase 6: Worker Integration

#### 6.1 — `src/worker/index.ts` — Add Limitless worker startup

**Current file structure**: The file imports `config` is NOT currently imported in `worker/index.ts` — you must add it. The Worker constructor is synchronous. The `start()` method is `async`. The `stop()` method is synchronous.

Add these imports at the top of the file (after existing imports):

```ts
import { config } from '../config.js';
import { LmPriceUpdater } from './lm-price-updater.js';
import { LmWebSocketClientWrapper } from './lm-ws-client.js';
import { LmOrderMatcher } from './lm-order-matcher.js';
import { LmResolver } from './lm-resolver.js';
```

Add private fields to the `Worker` class (after existing fields):

```ts
private lmPriceUpdater: LmPriceUpdater | null = null;
private lmWsClient: LmWebSocketClientWrapper | null = null;
private lmOrderMatcher: LmOrderMatcher | null = null;
private lmResolver: LmResolver | null = null;
```

Add to the end of the `constructor()` (after existing HL initialization):

```ts
if (config.LM_ENABLED) {
  this.lmOrderMatcher = new LmOrderMatcher(eventBus);
  this.lmPriceUpdater = new LmPriceUpdater(eventBus);

  this.lmWsClient = new LmWebSocketClientWrapper((event, data) => {
    if (event === 'orderbookUpdate') {
      const update = data as { marketSlug: string; orderbook: { bids: any[]; asks: any[] } };
      this.lmPriceUpdater!.handleOrderbookUpdate(update.marketSlug, update.orderbook);
    }
  });

  this.lmResolver = new LmResolver(eventBus);

  // Wire up: when prices change, run matcher
  eventBus.on('lm:mids', () => {
    this.lmOrderMatcher!.matchAll();
  });
}
```

Add to the end of `start()` (after existing HL startup, before the final log):

```ts
if (config.LM_ENABLED) {
  await this.lmPriceUpdater!.seedMarkets();

  // Get list of CLOB market slugs for WebSocket subscription
  const marketsRaw = await redis.hgetall(KEYS.LM_MARKETS);
  const slugs = Object.keys(marketsRaw);

  await this.lmWsClient!.connect();
  await this.lmWsClient!.setMarketSlugs(slugs);
  this.lmPriceUpdater!.startPolling();
  this.lmResolver!.start();

  logger.info({ markets: slugs.length }, 'Limitless worker started');
}
```

Add to the beginning of `stop()` (before existing HL teardown):

```ts
if (config.LM_ENABLED) {
  this.lmResolver?.stop();
  this.lmPriceUpdater?.stopPolling();
  // Note: SDK WebSocketClient.disconnect() is async, but stop() is sync
  // Fire-and-forget is acceptable here since we're shutting down
  this.lmWsClient?.close();
}
```

---

### Phase 7: WebSocket Push

#### 7.1 — `src/ws/types.ts` — Add Limitless WS types

Add to the existing types. **Pattern note**: The `WsSubscription` is a discriminated union on `type`. Each variant includes the fields needed for `subscriptionKey()` in `ws/server.ts`.

```ts
// Add these variants to the WsSubscription union type (after existing variants):
| { type: 'lmPrices' }
| { type: 'lmOrderUpdates'; user: string }
| { type: 'lmUserFills'; user: string }

// Add new outbound message types:
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
```

#### 7.2 — `src/ws/server.ts` — Add Limitless event listeners

Add imports at the top (extend existing type imports):

```ts
import type { LmPaperOrder, LmPaperFill } from '../types/limitless-order.js';
```

Add cases to the `subscriptionKey()` method's switch statement (before `default`):

```ts
case 'lmPrices':
  return 'lmPrices';
case 'lmOrderUpdates':
  return sub.user ? `lmOrderUpdates:${sub.user}` : null;
case 'lmUserFills':
  return sub.user ? `lmUserFills:${sub.user}` : null;

// Also add snapshot in handleSubscribe() (after existing l2Book snapshot):
// if (sub.type === 'lmPrices') {
//   const prices = await redis.hgetall(KEYS.LM_MARKET_PRICES);
//   if (Object.keys(prices).length > 0) {
//     const parsed: Record<string, { yes: string; no: string }> = {};
//     for (const [slug, json] of Object.entries(prices)) {
//       parsed[slug] = JSON.parse(json);
//     }
//     this.send(state.ws, { channel: 'lmPrices', data: { prices: parsed } });
//   }
// }

// In setupEventListeners(), add after existing event listeners:
this.eventBus.on('lm:mids', (event: { prices: Record<string, { yes: string; no: string }> }) => {
  const json = JSON.stringify({ channel: 'lmPrices', data: { prices: event.prices } });
  this.broadcast('lmPrices', json);
});

this.eventBus.on('lm:fill', (event: { userId: string; fill: LmPaperFill }) => {
  const json = JSON.stringify({
    channel: 'lmUserFills',
    data: { isSnapshot: false, user: event.userId, fills: [event.fill] },
  });
  this.broadcast(`lmUserFills:${event.userId}`, json);
});

this.eventBus.on('lm:orderUpdate', (event: { userId: string; order: LmPaperOrder; status: string }) => {
  const json = JSON.stringify({
    channel: 'lmOrderUpdates',
    data: [{ order: event.order, status: event.status }],
  });
  this.broadcast(`lmOrderUpdates:${event.userId}`, json);
});

this.eventBus.on('lm:resolution', (event: { userId: string; marketSlug: string; winningOutcome: string; payout: string }) => {
  // Broadcast as a special fill event so clients see the resolution
  // Clients can check the fill's closedPnl and dir fields
});
```

---

### Phase 8: Testing

#### 8.1 — `src/__tests__/lm-order-matcher.test.ts`

**Pattern to follow**: Exactly mirror `src/__tests__/matcher.test.ts` structure. The mock setup order is critical — mocks must be declared BEFORE the dynamic import of the module under test.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

// --- Mock redis BEFORE importing LmOrderMatcher ---
const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../config.js', () => ({
  config: {
    LM_ENABLED: true,
    LM_DEFAULT_BALANCE: 10_000,
    LOG_LEVEL: 'silent',
  },
}));

let tidCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++tidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));

// Dynamic import AFTER mocks
const { LmOrderMatcher } = await import('../worker/lm-order-matcher.js');

describe('LmOrderMatcher', () => {
  let eventBus: EventEmitter;
  let matcher: InstanceType<typeof LmOrderMatcher>;
  let fillEvents: Array<{ userId: string; fill: any }>;
  let orderEvents: Array<{ userId: string; order: any; status: string }>;

  const USER = '0xtest';
  const SLUG = 'test-market';

  beforeEach(() => {
    redisMock.flushall();
    tidCounter = 100;

    eventBus = new EventEmitter();
    matcher = new LmOrderMatcher(eventBus);

    fillEvents = [];
    orderEvents = [];
    eventBus.on('lm:fill', (e) => fillEvents.push(e));
    eventBus.on('lm:orderUpdate', (e) => orderEvents.push(e));
  });

  // Helper functions following same pattern as matcher.test.ts:
  // seedUser(balance) → hset LM_USER_ACCOUNT
  // seedPrice(slug, yesPrice, noPrice) → hset LM_MARKET_PRICES
  // createOpenOrder({ oid, marketSlug, outcome, side, price, size }) → hset LM_ORDER + sadd LM_ORDERS_OPEN
  // Test cases:

  // BUY YES limit order fills when yesPrice <= order.price
  // BUY NO limit order fills when noPrice <= order.price
  // SELL YES limit order fills when yesPrice >= order.price
  // SELL NO limit order fills when noPrice >= order.price

  // Order does not fill when price hasn't crossed
  // Order fills at limit price (not market price)

  // BUY fill: deducts balance, increases token balance, updates avg price
  // SELL fill: increases balance, decreases token balance, calculates realized PnL

  // Position fully closed when all tokens sold
  // Multiple buys update weighted average entry price correctly

  // Order status transitions: open → filled, open → cancelled
  // Filled orders removed from LM_ORDERS_OPEN set
  // Fill events emitted on eventBus

  // Edge cases:
  // Order for non-existent market → no fill (order stays open)
  // Zero-size fills don't execute
  // Balance cannot go negative (INV-DATA-003)
});
```

#### 8.2 — `src/__tests__/lm-order.test.ts`

```ts
describe('placeLmOrder', () => {
  // Rejects order for non-existent market
  // Rejects order with price < 0.01 or > 0.99
  // Rejects BUY order when insufficient balance
  // Rejects SELL order when insufficient tokens
  // Market order fills immediately if price available
  // Market order rejected if no price available
  // Limit order fills immediately if price crosses
  // Limit order rests if price doesn't cross
  // Order saved to Redis with correct fields
  // Events emitted correctly
});

describe('cancelLmOrder', () => {
  // Cancels open order
  // Rejects cancel for non-existent order
  // Rejects cancel for order owned by different user
  // Rejects cancel for already-filled order
  // Rejects cancel for already-cancelled order
  // Order removed from LM_ORDERS_OPEN set
});
```

#### 8.3 — `src/__tests__/lm-position.test.ts`

```ts
describe('getLmPortfolio', () => {
  // Returns empty portfolio for new user
  // Returns positions with correct PnL calculations
  // YES unrealized PnL = (currentYesPrice - yesAvgPrice) * yesBalance
  // NO unrealized PnL = (currentNoPrice - noAvgPrice) * noBalance
  // Account value = balance + totalUnrealizedPnl
  // Market value = sum of all position market values
  // Handles positions with zero balances correctly
});
```

**Verification**: After writing tests, run `npm run test:run` and confirm all pass.

---

### Phase 9: Database Migration

Run these commands after Phase 2 schema changes:

```bash
npm run db:generate    # Generate Drizzle migration
npm run db:push        # Apply to database
```

This creates the `lm_orders` and `lm_fills` tables.

---

## New Dependencies

| Package | Purpose | Install |
|---|---|---|
| `@limitless-exchange/sdk@1.0.3` | Official Limitless Exchange TypeScript SDK: MarketFetcher, WebSocketClient, HttpClient, types | `npm install @limitless-exchange/sdk@1.0.3` |

---

## Files Modified (Summary)

| File | Change Type | Description |
|---|---|---|
| `src/config.ts` | MODIFY | Add 6 LM_ env vars to envSchema |
| `src/store/keys.ts` | MODIFY | Add LM_ Redis key namespace (~12 keys) |
| `src/store/schema.ts` | MODIFY | Add lm_orders and lm_fills tables |
| `src/store/pg-sink.ts` | MODIFY | Add lm:fill and lm:orderUpdate event handlers |
| `src/store/pg-queries.ts` | MODIFY | Add getLmUserFillsPg and getLmUserFillsByTimePg |
| `src/worker/index.ts` | MODIFY | Add conditional Limitless worker startup |
| `src/api/server.ts` | MODIFY | Conditionally mount /limitless/* routes |
| `src/ws/server.ts` | MODIFY | Add lm:* event listeners and subscription handling |
| `src/ws/types.ts` | MODIFY | Add Limitless WS subscription and message types |
| `package.json` | MODIFY | Add @limitless-exchange/sdk dependency |

## Files Created (Summary)

| File | Description |
|---|---|
| `src/types/limitless.ts` | SDK type re-exports + LmCachedMarket (~40 lines) |
| `src/types/limitless-order.ts` | Paper trading types for Limitless (~60 lines) |
| `src/engine/lm-order.ts` | Order placement + cancellation (~200 lines) |
| `src/engine/lm-fill.ts` | Fill query functions (~20 lines) |
| `src/engine/lm-position.ts` | Portfolio view + open orders (~150 lines) |
| `src/worker/lm-ws-client.ts` | Thin wrapper around SDK WebSocketClient (~60 lines) |
| `src/worker/lm-price-updater.ts` | Market data → Redis (~120 lines) |
| `src/worker/lm-order-matcher.ts` | Order matching on price ticks (~200 lines) |
| `src/worker/lm-resolver.ts` | Market resolution poller (~100 lines) |
| `src/api/routes/lm-exchange.ts` | Trading endpoint (~80 lines) |
| `src/api/routes/lm-info.ts` | Info/query endpoint (~100 lines) |
| `src/api/routes/lm-hypaper.ts` | LM account admin endpoint (~80 lines) |
| `src/__tests__/lm-order-matcher.test.ts` | Order matching tests (~200 lines) |
| `src/__tests__/lm-order.test.ts` | Order placement tests (~150 lines) |
| `src/__tests__/lm-position.test.ts` | Portfolio/PnL tests (~100 lines) |

---

## Implementation Order (Recommended)

1. **Phase 1** — Types, config & SDK install (no runtime changes, run `npx tsc --noEmit` to verify)
2. **Phase 2** — Store layer (Redis keys, PG schema, pg-sink) + **Phase 9** — DB migration (`npm run db:generate && npm run db:push`) — run migration immediately after schema changes
3. **Phase 3** — Market data worker (prices flowing into Redis, no trading yet)
4. **Phase 4** — Engine (order placement + fill logic + portfolio view)
5. **Phase 5** — API routes (expose trading + info endpoints)
6. **Phase 6** — Worker integration (wire everything in `worker/index.ts`)
7. **Phase 7** — WebSocket push (real-time client updates)
8. **Phase 8** — Tests (write and run all test suites)

**Verification after each phase**:
- Phase 1: `npx tsc --noEmit` passes
- Phase 2: `npm run db:generate` succeeds, `npm run db:push` succeeds (creates lm_orders + lm_fills tables)
- Phase 3: `npx tsc --noEmit` passes (can't test runtime yet — Worker integration is Phase 6)
- Phase 4–5: `npx tsc --noEmit` passes
- Phase 6: Full build `npm run build` succeeds. Start server with `LM_ENABLED=true`, verify Redis `lm:markets` and `lm:prices` keys populate
- Phase 7: `npx tsc --noEmit` passes
- Phase 8: `npm run test` — all tests pass (both existing HL tests and new LM tests)

---

## Cross-Component Contracts

These are the boundaries where data crosses between modules. Each must be verified during implementation.

### Contract 1: LmPriceUpdater → Redis → LmOrderMatcher

- **Format**: `KEYS.LM_MARKET_PRICES` stores `JSON.stringify({yes: string, no: string})`
- **Consumer**: LmOrderMatcher reads with `JSON.parse()`, expects `yes` and `no` as string decimals
- **Invariant**: Prices must always be valid decimal strings in range [0.01, 0.99]

### Contract 2: LmOrderMatcher → eventBus → pg-sink

- **Event**: `lm:fill` carries `{ userId: string; fill: LmPaperFill }`
- **Consumer**: pg-sink inserts into `lm_fills` table
- **Invariant**: All fields of LmPaperFill must be present and correctly typed

### Contract 3: Redis hash ↔ LmPaperOrder

- **Write**: All fields of `LmPaperOrder` stored as individual hash fields (strings)
- **Read**: `parseOrder()` reconstructs the object from `Record<string, string>`
- **Invariant**: Every field written must be read back. `parseInt` for numbers, string comparisons for enums.

### Contract 4: API routes → Engine functions

- **Validation**: API routes validate input types/ranges before calling engine
- **Engine**: Engine functions assume inputs are pre-validated
- **Invariant**: Engine never receives invalid price ranges, empty strings, or wrong types
