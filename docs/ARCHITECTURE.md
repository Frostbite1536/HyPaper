# HyPaper Architecture

## Overview

| | |
|---|---|
| **Purpose** | Paper trading backend simulating HyperLiquid perps + Limitless prediction markets |
| **Type** | Stateful backend service (single process) |
| **Runtime** | Node.js + TypeScript (ESM) |
| **Target users** | Trading bot developers who want risk-free testing against live market data |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        External Data Sources                             │
│  HyperLiquid WebSocket ─────┐        ┌───── Limitless REST + WebSocket  │
│  (allMids, activeAssetCtx)  │        │  (SDK MarketFetcher + WsClient)  │
└─────────────────────────────┼────────┼──────────────────────────────────┘
                              │        │
                              ▼        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Worker Process                                 │
│                                                                          │
│  HL Pipeline:                        LM Pipeline (if LM_ENABLED):        │
│  ┌──────────┐  ┌──────────────┐     ┌──────────────┐  ┌────────────┐   │
│  │ WsClient │→ │PriceUpdater  │     │LmPriceUpdater│→ │LmOrderMatch│   │
│  │(reconnect)│ │(parse, write)│     │(poll + ws)   │  │   er       │   │
│  └──────────┘  └──────┬───────┘     └──────┬───────┘  └────────────┘   │
│                       │                     │                            │
│  ┌──────────────┐     │             ┌───────┴──────┐                     │
│  │ OrderMatcher │◄────┘             │  LmResolver  │                     │
│  └──────────────┘                   │  (60s poll)  │                     │
│                                     └──────────────┘                     │
│  ┌──────────────┐                                                        │
│  │FundingWorker │ (8hr cycle)                                            │
│  └──────────────┘                                                        │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ reads/writes
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                             Redis                                        │
│                                                                          │
│  HL namespace:                       LM namespace:                       │
│  market:mids  market:ctx:{coin}      lm:markets  lm:prices              │
│  order:{oid}  orders:open            lm:order:{oid}  lm:orders:open     │
│  user:{id}:account                   lm:user:{id}:account               │
│  user:{id}:pos:{asset}              lm:user:{id}:pos:{slug}            │
│  seq:oid  seq:tid                    (shared sequences)                  │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ reads
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    API Server (Hono on :3000)                             │
│                                                                          │
│  HL routes:                          LM routes:                          │
│  POST /exchange  (orders/cancel)     POST /lm/exchange  (orders/cancel)  │
│  POST /info      (queries)           POST /lm/info      (queries)        │
│  POST /hypaper   (admin)             POST /lm/hypaper   (admin)          │
│  GET  /health                                                            │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ EventBus
                             ▼
┌──────────────────────┬─────────────────────────────────────────────────┐
│   WebSocket (/ws)    │              PostgreSQL                          │
│   (push to clients)  │         (async write-behind)                    │
│   allMids, l2Book    │         pg-sink.ts listeners                    │
│   orderUpdates       │         fills, orders, users                    │
│   userFills          │         lm_fills, lm_orders                     │
│   lmOrderUpdates     │                                                 │
│   lmUserFills        │                                                 │
└──────────────────────┴─────────────────────────────────────────────────┘
```

## Components

### 1. Entry Point (`src/index.ts`)

Orchestrates startup in order: Redis → Postgres → Worker → pg-sink → HTTP → WebSocket.
Handles graceful shutdown on SIGTERM/SIGINT.

### 2. Worker (`src/worker/index.ts`)

Manages all background processes. On startup:
1. Seeds HL market data from REST API
2. Connects HL WebSocket, subscribes to `allMids` + `activeAssetCtx`
3. Starts HL funding worker (8hr cycle)
4. If `LM_ENABLED`: seeds LM markets, connects LM WebSocket, starts LM polling + resolver

**Dependencies**: Redis, HL API, Limitless SDK
**Emits**: `mids`, `lm:mids` (via sub-components)

### 3. Price Updaters

**HL** (`price-updater.ts`): Parses HL WebSocket messages → writes to `market:mids` and `market:ctx:{coin}` → triggers order matching.

**LM** (`lm-price-updater.ts`): Dual-source pricing:
- SDK WebSocket `orderbookUpdate` events (real-time)
- REST polling every `LM_POLL_INTERVAL_MS` (fallback)
- Computes midpoint from best bid/ask, clamps to [0.01, 0.99]
- Writes `{yes, no}` price JSON to `lm:prices` hash

### 4. Order Matchers

**HL** (`order-matcher.ts`):
- Scans `orders:open` set on each `mids` event
- Limit orders: fill when `midPx` crosses `limitPx`
- Trigger orders (TP/SL): activate when `midPx` crosses `triggerPx`
- Supports GTC, IOC, ALO time-in-force
- Calculates fees (maker/taker), updates margin, manages positions

**LM** (`lm-order-matcher.ts`):
- Scans `lm:orders:open` set on each `lm:mids` event
- Buy fills when market price <= order price
- Sell fills when market price >= order price
- No fees, no margin, no leverage
- Atomic balance check with rollback on insufficient funds

### 5. Market Resolver (`lm-resolver.ts`)

LM-only. Polls Limitless API every `LM_RESOLVER_INTERVAL_MS`:
1. Fetches current market data for all cached markets
2. If `winningOutcomeIndex != null` → market resolved
3. Winning shares → credit $1 per share to user balance
4. Losing shares → credit $0
5. Cancel all open orders for resolved market
6. Clean up market from Redis caches

### 6. API Routes

Mirror real exchange APIs so existing bots work unchanged.

**HL routes** (`/exchange`, `/info`, `/hypaper`):
- Same request/response shapes as `api.hyperliquid.xyz`
- User-specific queries served from Redis
- Market data queries proxied to real HL API
- `/hypaper` for paper-only actions (reset, setBalance)

**LM routes** (`/lm/exchange`, `/lm/info`, `/lm/hypaper`):
- Custom API for Limitless paper trading
- Order placement, cancellation, market queries, portfolio
- `/lm/hypaper` for account management

### 7. WebSocket Server (`ws/server.ts`)

Pushes real-time data to connected clients:
- `allMids` — HL mid prices
- `l2Book` — HL order book snapshots
- `orderUpdates` / `userFills` — HL per-user events
- `lmOrderUpdates` / `lmUserFills` — LM per-user events

Uses HL's subscribe/unsubscribe protocol.

### 8. Store Layer

**Redis** (`store/redis.ts`, `store/keys.ts`): Single ioredis connection. All keys defined in `KEYS` object with HL and LM namespaces.

**PostgreSQL** (`store/db.ts`, `store/schema.ts`): Drizzle ORM. Tables: `users`, `orders`, `fills`, `lm_orders`, `lm_fills`.

**pg-sink** (`store/pg-sink.ts`): Subscribes to EventBus events, writes to Postgres asynchronously. Never blocks the trading path.

## Data Models

### HL Position (Redis hash at `user:{id}:pos:{asset}`)
```
szi, entryPx, leverage, marginUsed, cumFunding,
cumFundingSinceOpen, cumFundingSinceChange
```

### LM Position (Redis hash at `lm:user:{id}:pos:{slug}`)
```
yesBalance, noBalance, yesCost, noCost, yesAvgPrice, noAvgPrice
```

### HL Order (Redis hash at `order:{oid}`)
```
oid, userId, asset, isBuy, limitPx, sz, orderType,
tif, reduceOnly, cloid, status, filledSz, avgFillPx,
createdAt, updatedAt, triggerPx, tpsl, isTriggered
```

### LM Order (Redis hash at `lm:order:{oid}`)
```
oid, userId, marketSlug, outcome, side, price, size,
orderType, status, filledSize, avgFillPrice, createdAt, updatedAt
```

## External Dependencies

| Dependency | Purpose | Failure Impact |
|---|---|---|
| HyperLiquid WebSocket | Live HL market prices | HL orders stop matching until reconnect |
| HyperLiquid REST API | Initial market data seed, proxied queries | Startup fails; proxied info queries fail |
| Limitless SDK REST | Market data, prices, resolution status | LM prices stale; resolution delayed |
| Limitless SDK WebSocket | Real-time orderbook updates | Falls back to REST polling |
| Redis | All hot state | Application cannot function |
| PostgreSQL | Historical persistence | Orders still work; history queries fail |

## Key Design Decisions

### 1. Redis-First State Management
**Context**: Need microsecond-level order matching on every price tick.
**Decision**: All hot state in Redis. Postgres is write-behind only.
**Trade-off**: Data loss on Redis failure (acceptable for paper trading).

### 2. Parallel Module Architecture for LM
**Context**: Adding Limitless support to an existing HL-only codebase.
**Decision**: `lm-` prefixed files alongside HL counterparts. Shared infra (Redis, Postgres, HTTP, WS, EventBus), separate business logic.
**Trade-off**: Some code duplication vs complete isolation and no risk of breaking HL.

### 3. No Authentication
**Context**: Paper trading with fake money; mirrors HL's public API model.
**Decision**: Wallet address in request body = user identity. Auto-create on first use.
**Trade-off**: Anyone can read/modify any account. Acceptable for paper trading.

### 4. decimal.js for All Financial Math
**Context**: Floating-point errors accumulate over many trades.
**Decision**: All monetary values are strings, arithmetic via decimal.js.
**Trade-off**: Slightly more verbose code; must use helper functions instead of `+`/`-`.

### 5. Shared OID/TID Sequences
**Context**: Both HL and LM need unique order/trade IDs.
**Decision**: Shared Redis sequences `seq:oid` and `seq:tid`.
**Trade-off**: IDs are globally unique but not contiguous per exchange.
