# HyPaper — LLM Development Guide

## What is HyPaper?

HyPaper is an open-source **paper trading backend** that simulates two exchanges:

1. **HyperLiquid (HL)** — perpetual futures (the original, upstream project)
2. **Limitless (LM)** — binary prediction markets (added in this fork)

It mirrors the real exchange APIs so existing bots can point at HyPaper and trade with fake money. All state lives in Redis; PostgreSQL is write-behind for history only.

**Upstream repo**: [GigabrainGG/HyPaper](https://github.com/GigabrainGG/HyPaper) (HL only)
**This fork**: Adds Limitless prediction market support via `lm-` prefixed modules.

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM, `"type": "module"`)
- **HTTP**: Hono + @hono/node-server
- **WebSocket**: `ws` (server), HL native WS + `@limitless-exchange/sdk` Socket.IO (clients)
- **State**: Redis (ioredis) — all hot state
- **Persistence**: PostgreSQL (drizzle-orm) — async, write-behind via EventBus
- **Math**: decimal.js — all financial arithmetic uses string decimals, never JS floats
- **Config**: zod-validated env vars (`src/config.ts`)
- **Logging**: pino
- **Testing**: vitest

## Quick Commands

```bash
npm run dev          # Start with hot reload (tsx watch)
npm run build        # TypeScript compile
npm run test:run     # Run all tests once
npm run test         # Watch mode tests
npm run test:realtime # Live HTTP+WS smoke test
npm run db:push      # Push schema to Postgres
npm run db:generate  # Generate migration SQL
```

## Project Structure

```
src/
├── index.ts                 # Entry point: Redis → DB → Worker → HTTP → WS
├── config.ts                # Zod env schema (HL + LM vars)
│
├── api/                     # HTTP layer (Hono)
│   ├── server.ts            # App setup, route mounting
│   ├── middleware/
│   │   ├── auth.ts          # Auto-create accounts (ensureAccount)
│   │   └── rate-limit.ts    # IP-based rate limiting
│   └── routes/
│       ├── exchange.ts      # POST /exchange (HL orders)
│       ├── info.ts          # POST /info (HL queries)
│       ├── hypaper.ts       # POST /hypaper (HL admin)
│       ├── lm-exchange.ts   # POST /lm/exchange (LM orders)
│       ├── lm-info.ts       # POST /lm/info (LM queries)
│       └── lm-hypaper.ts    # POST /lm/hypaper (LM admin)
│
├── engine/                  # Trading logic (stateless functions, Redis I/O)
│   ├── order.ts             # HL order placement + cancellation
│   ├── margin.ts            # HL margin checks, PnL, liquidation price
│   ├── position.ts          # HL clearinghouse state builder
│   ├── fill.ts              # HL fill history queries
│   ├── lm-order.ts          # LM order placement + cancellation
│   ├── lm-position.ts       # LM portfolio view + open orders
│   └── lm-fill.ts           # LM fill queries (Postgres)
│
├── worker/                  # Background processes
│   ├── index.ts             # Worker class: wires up all subsystems
│   ├── ws-client.ts         # HL WebSocket client (reconnecting)
│   ├── price-updater.ts     # HL WS messages → Redis prices + EventBus
│   ├── order-matcher.ts     # HL order matching on each price tick
│   ├── funding-worker.ts    # HL periodic funding rate application
│   ├── lm-ws-client.ts      # LM SDK WebSocket wrapper
│   ├── lm-price-updater.ts  # LM market data → Redis prices
│   ├── lm-order-matcher.ts  # LM order matching on price ticks
│   └── lm-resolver.ts       # LM market resolution poller
│
├── store/                   # Persistence layer
│   ├── redis.ts             # Redis connection (ioredis singleton)
│   ├── keys.ts              # All Redis key definitions (HL + LM namespaces)
│   ├── db.ts                # PostgreSQL connection (postgres.js + drizzle)
│   ├── schema.ts            # Drizzle ORM table definitions
│   ├── pg-sink.ts           # EventBus → async Postgres writes
│   └── pg-queries.ts        # Typed query functions
│
├── ws/                      # WebSocket server (outbound to clients)
│   ├── server.ts            # /ws endpoint, subscription management
│   └── types.ts             # WS message types, EventBus event types
│
├── types/                   # TypeScript interfaces
│   ├── hl.ts                # HyperLiquid API type mirrors
│   ├── order.ts             # HL internal order/fill types
│   ├── position.ts          # HL internal position types
│   ├── limitless.ts         # Re-exports from @limitless-exchange/sdk
│   └── limitless-order.ts   # LM paper order/fill/position types
│
├── utils/                   # Shared utilities
│   ├── math.ts              # decimal.js wrappers: D(), add(), sub(), mul(), div(), etc.
│   ├── id.ts                # Redis-backed sequence IDs: nextOid(), nextTid()
│   ├── logger.ts            # pino logger singleton
│   ├── slippage.ts          # VWAP fill price calculator (HL only)
│   └── l2-cache.ts          # L2 book cache (HL only)
│
└── __tests__/               # vitest test files
    ├── helpers/redis-mock.ts
    ├── matcher.test.ts
    ├── math.test.ts
    ├── margin.test.ts
    ├── fees.test.ts
    ├── funding.test.ts
    ├── slippage.test.ts
    ├── price-updater.test.ts
    ├── api-server.test.ts
    ├── lm-order.test.ts
    ├── lm-order-matcher.test.ts
    └── lm-position.test.ts
```

## Architecture Rules

### Namespace Isolation

HL and LM share Redis/Postgres/HTTP/WS but have **completely separate key namespaces**:

| Scope | HL keys | LM keys |
|-------|---------|---------|
| Prices | `market:mids`, `market:ctx:{coin}` | `lm:prices`, `lm:markets` |
| Orders | `order:{oid}`, `orders:open` | `lm:order:{oid}`, `lm:orders:open` |
| Users | `user:{id}:account` | `lm:user:{id}:account` |
| Positions | `user:{id}:pos:{asset}` | `lm:user:{id}:pos:{slug}` |

**Never read/write across namespaces.** HL code must not touch `lm:*` keys and vice versa.

### Redis-First

Redis is the source of truth for all hot state. PostgreSQL is append-only historical storage. Postgres writes **must never block** the trading path — they go through `eventBus` → `pg-sink.ts`.

### Decimal Math

All monetary values are `string` type and use `decimal.js` via `src/utils/math.ts`. **Never use JavaScript `number` for financial math.** The helpers are:
- `D(value)` — create Decimal
- `add(a, b)`, `sub(a, b)`, `mul(a, b)`, `div(a, b)` — arithmetic returning strings
- `gt(a, b)`, `gte(a, b)`, `lt(a, b)`, `lte(a, b)` — comparisons
- `neg(a)` — negate
- `isZero(a)` — check if zero
- `abs(a)` — absolute value

### EventBus Pattern

`eventBus` is a Node.js `EventEmitter` shared across all subsystems. Key events:

| Event | Emitter | Consumers |
|-------|---------|-----------|
| `mids` | PriceUpdater | OrderMatcher, WS server |
| `fill` | OrderMatcher | pg-sink, WS server |
| `orderUpdate` | Engine | pg-sink, WS server |
| `lm:mids` | LmPriceUpdater | LmOrderMatcher |
| `lm:fill` | LmOrderMatcher | pg-sink, WS server |
| `lm:orderUpdate` | LmOrderMatcher | pg-sink, WS server |

## How Order Matching Works

### HL (Perpetual Futures)
1. `PriceUpdater` receives `allMids` via HL WebSocket
2. Writes mid prices to Redis `market:mids`
3. Emits `mids` event → `OrderMatcher.matchAll()`
4. Matcher scans `orders:open`, compares each order's limit price vs current mid
5. Fill: deducts margin, creates/updates position, credits PnL, emits events

### LM (Prediction Markets)
1. `LmPriceUpdater` receives prices via SDK WebSocket + REST polling
2. Writes YES/NO prices to Redis `lm:prices`
3. Emits `lm:mids` event → `LmOrderMatcher.matchAll()`
4. Matcher scans `lm:orders:open`, compares order price vs current market price
5. Fill: deducts balance (buy) or token balance (sell), updates position, emits events

### LM Market Resolution
1. `LmResolver` polls Limitless API every 60s for resolved markets
2. When `winningOutcomeIndex` is set: winning shares pay $1, losers pay $0
3. Positions closed, balances credited, open orders cancelled, market data cleaned up

## Code Conventions

- **File naming**: `lm-*.ts` for all Limitless code, matching HL counterpart names
- **No floating point**: Use `src/utils/math.ts` for all financial calculations
- **Error handling**: Log with pino, never swallow errors silently
- **Type safety**: Use strict TypeScript, avoid `any`
- **Testing**: Write vitest tests in `src/__tests__/`, use `helpers/redis-mock.ts` for Redis
- **No auth**: Wallet address passed in request body identifies users; accounts auto-created

## Known Issues & Technical Debt

See `docs/INVARIANTS.md` for system invariants and known violations. Key items:

- `clampPrice()` in `lm-price-updater.ts` doesn't validate NaN/Infinity inputs
- `executeFill()` in `lm-order-matcher.ts` doesn't recheck order status before filling
- `winningOutcomeIndex` in `lm-resolver.ts` not bounds-checked (only null-checked)
- HL `exchange.ts` route missing try-catch on `c.req.json()`
- Funding charges don't emit events to pg-sink/WebSocket

## Review Checklist

Before merging any PR, verify:

1. No JavaScript `number` used for prices, sizes, or balances
2. No cross-namespace key access (HL touching `lm:*` or vice versa)
3. No `await` in the Postgres write path that would block order matching
4. All new Redis keys added to `src/store/keys.ts`
5. All new event types documented in `src/ws/types.ts`
6. Tests pass: `npm run test:run`
7. TypeScript compiles: `npx tsc --noEmit`
