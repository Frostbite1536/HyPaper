# HyPaper

Open-source paper trading backend for [HyperLiquid](https://hyperliquid.xyz) perpetual futures and [Limitless](https://limitless.exchange) prediction markets.

> **Fork note**: This is a fork of [GigabrainGG/HyPaper](https://github.com/GigabrainGG/HyPaper) that adds Limitless prediction market paper trading. The upstream project supports HyperLiquid only.

Swap `api.hyperliquid.xyz` for your HyPaper URL in your existing HL bot and it just works — same request/response shapes, same WebSocket protocol, no wallet signing required. The Limitless integration adds parallel API routes for binary outcome market trading.

## How it works

```
                         ┌── HL WebSocket Feed ──┐
                         │                       │
                         │  ┌── Limitless SDK ──┐│
                         │  │  REST + WebSocket ││
                         ▼  ▼                   ││
                    Worker Process               ││
                    - HL price updates           ││
                    - HL order matching           │
                    - LM price updates ◄─────────┘
                    - LM order matching
                    - LM market resolution
                         │
                         ▼
                    Redis (all hot state)
                         │
                         ▼
                    Hono API Server
                    POST /exchange      (HL)
                    POST /info          (HL)
                    POST /hypaper       (HL admin)
                    POST /lm/exchange   (Limitless)
                    POST /lm/info       (Limitless)
                    POST /lm/hypaper    (Limitless admin)
                         │
                    EventBus
                         │
                    ┌────┴────┐
                    ▼         ▼
               WebSocket   PostgreSQL
               Server      (async persistence)
               (/ws)
```

- **Worker** streams live market data from HyperLiquid and Limitless, fills paper orders on every price tick
- **Redis** holds all state: prices, positions, orders, fills, balances (separate namespaces per exchange)
- **API** mirrors HL's endpoints (HL bots need zero code changes) + custom LM endpoints
- **WebSocket** pushes real-time updates to connected clients using HL's subscribe/unsubscribe protocol

## Quick start

```bash
git clone https://github.com/Frostbite1536/HyPaper.git
cd HyPaper
npm install
docker compose up -d   # starts Redis
npm run dev            # starts server with hot reload
```

Server runs on `http://localhost:3000`. WebSocket at `ws://localhost:3000/ws`.

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```env
# Core
DATABASE_URL=postgresql://localhost:5432/hypaper
REDIS_URL=redis://localhost:6379
PORT=3000
LOG_LEVEL=info

# HyperLiquid
HL_WS_URL=wss://api.hyperliquid.xyz/ws
HL_API_URL=https://api.hyperliquid.xyz
DEFAULT_BALANCE=100000
FEES_ENABLED=true
FEE_RATE_TAKER=0.00035
FEE_RATE_MAKER=0.0001
FUNDING_ENABLED=true
FUNDING_INTERVAL_MS=28800000

# Limitless (prediction markets)
LM_ENABLED=false                              # Set to true to enable
LM_API_URL=https://api.limitless.exchange
LM_WS_URL=wss://ws.limitless.exchange
LM_DEFAULT_BALANCE=10000
LM_POLL_INTERVAL_MS=30000                     # Price polling fallback
LM_RESOLVER_INTERVAL_MS=60000                 # Resolution check interval
```

Bring your own Redis — any Redis 7+ works (local, Docker, Upstash, Redis Cloud, etc.).

## Realtime smoke test

Once the backend is running and connected to Redis/Postgres, you can exercise the live HTTP + WebSocket surface with a paper wallet:

```bash
npm run test:realtime
```

Useful options:

```bash
npm run test:realtime -- --base-url http://localhost:3000 --wallet 0xpaperbot --coin BTC
```

The script:

- checks `GET /health`
- tests supported `POST /hypaper` actions
- tests supported `POST /exchange` actions (`order`, `cancel`, `cancelByCloid`, `updateLeverage`)
- verifies `POST /info` local paper-state queries and proxied live-market queries
- connects to `WebSocket /ws` and verifies `allMids`, `l2Book`, `orderUpdates`, and `userFills`
- uses only paper balances and resets the test account at the end by default

## Authentication

HyPaper has **no authentication**. This mirrors HL's public info API and simplifies integration.

- `/info` is fully public. User-specific queries pass `user` (wallet address) in the request body, just like HL.
- `/exchange` requires a `wallet` field in the request body to identify the user. Accounts are auto-created on first use with the configured default balance.
- `/hypaper` uses `user` in the request body.

Any string works as a wallet address — use your real `0x...` address, a test address, or any identifier you like.

## API reference

### `GET /health`

Health check.

### `POST /info`

Mirrors [HL's info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Send `{"type": "..."}` in the body.

**Served from Redis (paper state):**

| type | body | description |
|------|------|-------------|
| `allMids` | — | Mid prices for all assets |
| `clearinghouseState` | `{"user": "0x..."}` | Positions, margin summary, account value |
| `openOrders` | `{"user": "0x..."}` | Open orders |
| `frontendOpenOrders` | `{"user": "0x..."}` | Open orders with extra fields (tif, trigger, etc.) |
| `userFills` | `{"user": "0x..."}` | Recent fills |
| `userFillsByTime` | `{"user": "0x...", "startTime": ..., "endTime": ...}` | Fills filtered by time |
| `orderStatus` | `{"oid": 123}` | Status of a specific order |
| `activeAssetCtx` | `{"coin": "BTC"}` | Asset context (funding, OI, mark price) |

**Proxied to real HL (live market data):**

| type | description |
|------|-------------|
| `meta` | Universe metadata (asset names, decimals, max leverage) |
| `metaAndAssetCtxs` | Meta + all asset contexts |
| `candleSnapshot` | OHLCV candles |
| `fundingHistory` | Historical funding rates |
| `l2Book` | L2 order book |

Any unrecognized type is also proxied to HL.

### `POST /exchange`

Mirrors [HL's exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint). Send `{"wallet": "0x...", "action": {...}}` in the body.

| action.type | description |
|-------------|-------------|
| `order` | Place orders (limit, IOC, ALO, trigger/TP-SL) |
| `cancel` | Cancel orders by asset + oid |
| `cancelByCloid` | Cancel orders by client order ID |
| `updateLeverage` | Set leverage + cross/isolated for an asset |

**Example — place a limit buy:**

```bash
curl -s http://localhost:3000/exchange \
  -H 'Content-Type: application/json' \
  -d '{
    "wallet": "0xYourAddress",
    "action": {
      "type": "order",
      "grouping": "na",
      "orders": [{
        "a": 0, "b": true, "p": "90000", "s": "0.01",
        "r": false, "t": {"limit": {"tif": "Gtc"}}
      }]
    }
  }'
```

**Example — cancel an order:**

```bash
curl -s http://localhost:3000/exchange \
  -H 'Content-Type: application/json' \
  -d '{
    "wallet": "0xYourAddress",
    "action": {"type": "cancel", "cancels": [{"a": 0, "o": 1}]}
  }'
```

### `POST /hypaper`

Paper-trading-specific endpoints (not part of HL's API).

| type | body | description |
|------|------|-------------|
| `resetAccount` | `{"user": "0x..."}` | Wipe all positions, orders, fills. Reset balance. |
| `setBalance` | `{"user": "0x...", "balance": 500000}` | Set account balance |
| `getAccountInfo` | `{"user": "0x..."}` | Get userId, balance, creation time |

### `WebSocket /ws`

Mirrors [HL's WebSocket API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket). Connect to `ws://localhost:3000/ws`.

**Subscribe to channels:**

```json
{"method": "subscribe", "subscription": {"type": "allMids"}}
{"method": "subscribe", "subscription": {"type": "l2Book", "coin": "BTC"}}
{"method": "subscribe", "subscription": {"type": "orderUpdates", "user": "0x..."}}
{"method": "subscribe", "subscription": {"type": "userFills", "user": "0x..."}}
```

**Unsubscribe:**

```json
{"method": "unsubscribe", "subscription": {"type": "allMids"}}
```

**Server pushes:**

```json
{"channel": "allMids", "data": {"mids": {"BTC": "42500", ...}}}
{"channel": "l2Book", "data": {"coin": "BTC", "levels": [...], "time": ...}}
{"channel": "orderUpdates", "data": [{"order": {...}, "status": "filled", ...}]}
{"channel": "userFills", "data": {"isSnapshot": false, "user": "0x...", "fills": [...]}}
```

All channels are open — no authentication required.

## Limitless Prediction Markets

Enable with `LM_ENABLED=true`. This adds parallel API routes for binary outcome market trading.

### `POST /lm/exchange`

| action.type | description |
|-------------|-------------|
| `order` | Place a limit or market order on a prediction market |
| `cancel` | Cancel an open order |

**Example — buy YES shares:**

```bash
curl -s http://localhost:3000/lm/exchange \
  -H 'Content-Type: application/json' \
  -d '{
    "wallet": "0xYourAddress",
    "action": {
      "type": "order",
      "marketSlug": "btc-100k-2024",
      "outcome": "yes",
      "side": "buy",
      "price": "0.55",
      "size": "10",
      "orderType": "limit"
    }
  }'
```

### `POST /lm/info`

| type | body | description |
|------|------|-------------|
| `markets` | — | All active Limitless markets |
| `market` | `{"slug": "..."}` | Single market details |
| `portfolio` | `{"user": "0x..."}` | User positions + PnL |
| `openOrders` | `{"user": "0x..."}` | Open orders |
| `orderStatus` | `{"oid": 123}` | Order status |
| `userFills` | `{"user": "0x..."}` | Fill history |

### `POST /lm/hypaper`

| type | body | description |
|------|------|-------------|
| `resetAccount` | `{"user": "0x..."}` | Wipe LM positions, orders, fills. Reset balance. |
| `setBalance` | `{"user": "0x...", "balance": 10000}` | Set LM account balance |
| `getAccountInfo` | `{"user": "0x..."}` | Get LM account info |

### How LM Order Matching Works

- **Limit buy** fills when `marketPrice <= orderPrice`
- **Limit sell** fills when `marketPrice >= orderPrice`
- Prices sourced from Limitless orderbooks (WebSocket + REST polling)
- Markets resolve when the Limitless API reports a `winningOutcomeIndex`
- Winning shares pay $1.00, losing shares pay $0.00

---

## Using with existing HL bots

Point your bot's base URL at HyPaper and pass the wallet address:

```python
# Before (real HL — uses wallet signing)
exchange = HyperliquidExchange(base_url="https://api.hyperliquid.xyz")

# After (HyPaper — pass wallet in body)
exchange = HyperliquidExchange(base_url="http://localhost:3000")
```

If your SDK sends `nonce`/`signature`/`vaultAddress`, that's fine — HyPaper ignores them. You only need to add a `wallet` field to `/exchange` requests.

## Order matching

Orders are matched against live mid prices from HyperLiquid on every WebSocket tick:

- **Limit buy** fills when `midPx <= limitPx`
- **Limit sell** fills when `midPx >= limitPx`
- **Stop loss (sell/close long)** triggers when `midPx <= triggerPx`
- **Stop loss (buy/close short)** triggers when `midPx >= triggerPx`
- **Take profit (sell/close long)** triggers when `midPx >= triggerPx`
- **Take profit (buy/close short)** triggers when `midPx <= triggerPx`

Time-in-force behavior:

- **GTC** — fills immediately if price crosses, otherwise rests on book
- **IOC** — fills immediately or rejects
- **ALO** — rejects if it would fill immediately (post-only)

## Fees & Funding

**Maker/Taker fees** are enabled by default and match HyperLiquid's fee schedule:

- **Taker** (IOC, GTC immediate fill, triggers): 3.5 bps (`0.00035`)
- **Maker** (rested limit orders filled by price movement): 1 bp (`0.0001`)
- `crossed: true` in fills indicates a taker fill, `false` for maker
- Disable with `FEES_ENABLED=false`

**Funding rates** are applied every 8 hours (matching HL's schedule):

- Funding rates are sourced from live HyperLiquid market data
- Longs pay when the funding rate is positive, shorts receive
- Tracked per-position via `cumFunding`, `cumFundingSinceOpen`, `cumFundingSinceChange`
- Disable with `FUNDING_ENABLED=false`

## Deployment

### Docker Compose (simplest)

```bash
docker compose --profile prod up -d
```

### Any Docker host

The Dockerfile produces a production image. Provide `REDIS_URL` and you're set:

```bash
docker build -t hypaper .
docker run -p 3000:3000 -e REDIS_URL=redis://your-redis:6379 hypaper
```

### Platform recommendations

| Platform | Notes |
|----------|-------|
| **Railway** | Managed Redis add-on, WebSocket support, auto-detects Dockerfile |
| **Fly.io** | Native WS support, Upstash Redis add-on |
| **VPS (Hetzner, DO)** | `docker compose --profile prod up -d`, full control |

WebSocket support is required — platforms like Vercel/Cloudflare Workers won't work.

## Project structure

```
src/
├── api/
│   ├── middleware/auth.ts        # Auto-create accounts on first use
│   ├── middleware/rate-limit.ts
│   ├── routes/exchange.ts        # POST /exchange (HL)
│   ├── routes/info.ts            # POST /info (HL)
│   ├── routes/hypaper.ts         # POST /hypaper (HL admin)
│   ├── routes/lm-exchange.ts     # POST /lm/exchange (Limitless)
│   ├── routes/lm-info.ts         # POST /lm/info (Limitless)
│   ├── routes/lm-hypaper.ts      # POST /lm/hypaper (Limitless admin)
│   └── server.ts                 # Hono app setup
├── engine/
│   ├── fill.ts                   # HL fill history queries
│   ├── margin.ts                 # HL margin checks + PnL
│   ├── order.ts                  # HL order validation + placement
│   ├── position.ts               # HL clearinghouse state builder
│   ├── lm-order.ts               # LM order placement + cancellation
│   ├── lm-position.ts            # LM portfolio view + open orders
│   └── lm-fill.ts                # LM fill queries
├── store/
│   ├── keys.ts                   # Redis key schema (HL + LM namespaces)
│   ├── redis.ts                  # Redis connection
│   ├── db.ts                     # PostgreSQL connection
│   ├── schema.ts                 # Drizzle ORM tables
│   ├── pg-sink.ts                # EventBus → async Postgres writes
│   └── pg-queries.ts             # Typed query functions
├── types/
│   ├── hl.ts                     # HyperLiquid API type mirrors
│   ├── order.ts                  # HL internal order types
│   ├── position.ts               # HL internal position types
│   ├── limitless.ts              # Re-exports from @limitless-exchange/sdk
│   └── limitless-order.ts        # LM paper order/fill/position types
├── utils/
│   ├── id.ts                     # Sequence ID generation
│   ├── logger.ts                 # Pino logger
│   ├── math.ts                   # decimal.js wrappers
│   ├── slippage.ts               # VWAP fill price calculator (HL)
│   └── l2-cache.ts               # L2 book cache (HL)
├── worker/
│   ├── index.ts                  # Worker startup, wires all subsystems
│   ├── ws-client.ts              # HL WebSocket with reconnect
│   ├── price-updater.ts          # HL WS → Redis + eventBus
│   ├── order-matcher.ts          # HL order matching engine
│   ├── funding-worker.ts         # HL periodic funding fees
│   ├── lm-ws-client.ts           # LM SDK WebSocket wrapper
│   ├── lm-price-updater.ts       # LM market data → Redis
│   ├── lm-order-matcher.ts       # LM order matching engine
│   └── lm-resolver.ts            # LM market resolution poller
├── ws/
│   ├── server.ts                 # WebSocket server (/ws)
│   └── types.ts                  # WS message + event bus types
├── config.ts                     # Zod-validated env config
└── index.ts                      # Entry point
```

## Tech stack

- **Runtime:** Node.js + TypeScript (ESM)
- **HTTP:** [Hono](https://hono.dev) + @hono/node-server
- **WebSocket:** [ws](https://github.com/websockets/ws) (server), @limitless-exchange/sdk (LM client)
- **State:** [Redis](https://redis.io) via ioredis
- **Persistence:** PostgreSQL via [drizzle-orm](https://orm.drizzle.team)
- **Math:** [decimal.js](https://github.com/MikeMcl/decimal.js) (no floating point)
- **Limitless SDK:** [@limitless-exchange/sdk](https://www.npmjs.com/package/@limitless-exchange/sdk) (market data, WebSocket, types)
- **Validation:** zod
- **Logging:** pino
- **Testing:** vitest

## Documentation

| Document | Description |
|----------|-------------|
| `CLAUDE.md` | LLM development guide — architecture rules, conventions, known issues |
| `REVIEW.md` | Code review guidelines and checklist |
| `docs/ARCHITECTURE.md` | System architecture, components, data flow, design decisions |
| `docs/STATE_MACHINES.md` | All state machines with valid transitions |
| `docs/INVARIANTS.md` | System invariants, contracts, and known violations |
| `PLAN.md` | Original Limitless integration plan |

## Contributing

Contributions welcome. Please open an issue first for large changes.

## License

MIT
