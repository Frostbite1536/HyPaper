# HyPaper

Open-source paper trading backend for [HyperLiquid](https://hyperliquid.xyz). Swap `api.hyperliquid.xyz` → `api.hypaper.xyz` in your existing HL bot and it just works — same request/response shapes, but wallet signing is replaced with API key auth.

## How it works

```
HL WebSocket Feed ──▶ Worker Process ──▶ Redis (all hot state)
                      - price updates        │
                      - order matching        │ reads
                      - fill execution        ▼
                                         Hono API Server
                                         POST /exchange
                                         POST /info
                                         POST /hypaper
```

- **Worker** streams live market data from HyperLiquid via WebSocket and fills paper orders on every price tick
- **Redis** holds all state: prices, positions, orders, fills, balances
- **API** mirrors HL's endpoints so existing bots need zero code changes

## Quick start

```bash
git clone https://github.com/your-org/hypaper-backend.git
cd hypaper-backend
npm install
docker compose up -d   # starts Redis
npm run dev            # starts server with hot reload
```

Server runs on `http://localhost:3000`.

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```env
# Redis — supports redis:// and rediss:// (TLS) for cloud providers
REDIS_URL=redis://localhost:6379

# HyperLiquid endpoints
HL_WS_URL=wss://api.hyperliquid.xyz/ws
HL_API_URL=https://api.hyperliquid.xyz

# Server
PORT=3000

# Paper trading
DEFAULT_BALANCE=10000000

# Logging: fatal, error, warn, info, debug, trace
LOG_LEVEL=info

# WebSocket reconnect tuning (ms)
WS_RECONNECT_MIN_MS=1000
WS_RECONNECT_MAX_MS=30000
```

Bring your own Redis — any Redis 7+ works (local, Docker, Upstash, Redis Cloud, etc.).

## Authentication

HyPaper replaces HL's wallet signing with API keys:

- **With key:** Send `X-API-Key: hp_xxxxx` header
- **Without key:** Auto-creates an account and returns the key in `X-API-Key` response header

Request bodies still accept `action`, `nonce`, `signature` fields like HL — `nonce`/`signature`/`vaultAddress` are simply ignored.

## API reference

### `GET /health`

Health check. No auth required.

### `POST /info`

Mirrors [HL's info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Send `{"type": "..."}` in the body.

**Served from Redis (paper state):**

| type | description |
|------|-------------|
| `allMids` | Mid prices for all assets |
| `clearinghouseState` | Positions, margin summary, account value |
| `openOrders` | Open orders for the authenticated user |
| `frontendOpenOrders` | Open orders with extra fields (tif, trigger, etc.) |
| `userFills` | Recent fills |
| `userFillsByTime` | Fills filtered by `startTime`/`endTime` |
| `orderStatus` | Status of a specific order by `oid` |
| `activeAssetCtx` | Asset context (funding, OI, mark price) by `coin` |

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

Mirrors [HL's exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint). Send `{"action": {...}}` in the body.

| action.type | description |
|-------------|-------------|
| `order` | Place orders (limit, IOC, ALO, trigger/TP-SL) |
| `cancel` | Cancel orders by asset + oid |
| `cancelByCloid` | Cancel orders by client order ID |
| `updateLeverage` | Set leverage + cross/isolated for an asset |

**Example — place a limit buy:**

```bash
curl -s http://localhost:3000/exchange \
  -H "X-API-Key: $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
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
  -H "X-API-Key: $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"action": {"type": "cancel", "cancels": [{"a": 0, "o": 1}]}}'
```

### `POST /hypaper`

Paper-trading-specific endpoints. Send `{"type": "..."}` in the body.

| type | body | description |
|------|------|-------------|
| `resetAccount` | — | Wipe all positions, orders, fills. Reset balance to default. |
| `setBalance` | `{"balance": 5000000}` | Set account balance to a specific value |
| `getAccountInfo` | — | Get userId, balance, creation time |

## Using with existing HL bots

Point your bot's base URL at HyPaper:

```python
# Before
exchange = HyperliquidExchange(base_url="https://api.hyperliquid.xyz")

# After
exchange = HyperliquidExchange(base_url="http://localhost:3000")
```

Add the API key header however your SDK allows. If your SDK sends `nonce`/`signature`, that's fine — HyPaper ignores them.

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

## Project structure

```
src/
├── api/
│   ├── middleware/auth.ts   # API key auth + auto-session
│   ├── routes/exchange.ts   # POST /exchange
│   ├── routes/info.ts       # POST /info
│   ├── routes/hypaper.ts    # POST /hypaper
│   └── server.ts            # Hono app setup
├── engine/
│   ├── fill.ts              # Fill history queries
│   ├── margin.ts            # Margin checks + PnL calculations
│   ├── order.ts             # Order validation + placement
│   └── position.ts          # Clearinghouse state builder
├── store/
│   ├── keys.ts              # Redis key schema
│   └── redis.ts             # Redis connection
├── types/
│   ├── hl.ts                # HyperLiquid API type mirrors
│   ├── order.ts             # Internal order types
│   └── position.ts          # Internal position types
├── utils/
│   ├── id.ts                # API key + ID generation
│   ├── logger.ts            # Pino logger
│   └── math.ts              # decimal.js wrappers
├── worker/
│   ├── index.ts             # Worker startup + market data seeding
│   ├── order-matcher.ts     # Core matching engine
│   ├── price-updater.ts     # WS message → Redis
│   └── ws-client.ts         # HL WebSocket with reconnect
├── config.ts                # Zod-validated env config
└── index.ts                 # Entry point
```

## Tech stack

- **Runtime:** Node.js + TypeScript
- **HTTP:** [Hono](https://hono.dev) + @hono/node-server
- **State:** [Redis](https://redis.io) via ioredis
- **Math:** [decimal.js](https://github.com/MikeMcl/decimal.js) (no floating point)
- **Validation:** zod
- **Logging:** pino

## License

MIT
