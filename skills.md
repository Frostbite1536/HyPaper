# HyPaper API Reference

Paper trading backend — drop-in replacement for HyperLiquid's API. Fake money, real wallet addresses, same wire format.

## Base URL & Auth

- **Base URL**: `http://localhost:3000` (configurable via `PORT`)
- **Auth**: None. Wallet address passed in request body.
- **Content-Type**: `application/json` for all endpoints.

**Health check:** `GET /health` → `{ "status": "ok", "time": 1705000000000 }`

## Account Lifecycle

- Auto-created on first request with **$100,000 USDC** default balance.
- Wallet address normalized to **lowercase**.
- Persisted in Redis (real-time) + PostgreSQL (historical).

---

## POST /exchange

All trading actions. Body: `{ "wallet": "0x...", "action": { ... } }`

Response wrapper:
```json
{ "status": "ok", "response": { "type": "order"|"cancel"|"default", "data": { "statuses": [...] } } }
```

### action.type: "order"

```json
{
  "type": "order",
  "orders": [{
    "a": 0,            // asset index
    "b": true,         // isBuy
    "p": "50000",      // price (string)
    "s": "1",          // size (string)
    "r": false,        // reduceOnly
    "t": {
      "limit": { "tif": "Gtc" }
    },
    "c": "my-cloid"    // optional client order ID
  }],
  "grouping": "na"     // "na" | "normalTpsl" | "positionTpsl"
}
```

**Trigger orders** — use `t.trigger` instead of/alongside `t.limit`:
```json
{
  "t": {
    "trigger": {
      "isMarket": true,
      "triggerPx": "49000",
      "tpsl": "tp"
    },
    "limit": { "tif": "Gtc" }
  }
}
```

**TIF behavior:**

| TIF | Behavior |
|-----|----------|
| `Gtc` | Fills if mid crosses limit price, otherwise rests on book |
| `Ioc` | Must fill immediately or rejects: `"IOC order could not be filled"` |
| `Alo` | Rejects if would cross spread: `"ALO order would have crossed"` |

**Validation:** Max 50 orders/request. `a` must be valid asset index. `p` and `s` must be positive strings.

**Status responses per order:**
```json
{ "resting": { "oid": 123 } }
{ "filled": { "totalSz": "1", "avgPx": "50010.5", "oid": 123 } }
{ "error": "Insufficient margin" }
```

### action.type: "cancel"

```json
{ "type": "cancel", "cancels": [{ "a": 0, "o": 12345 }] }
```
`a` = asset index, `o` = order ID. Errors: `"Order {oid} not found"`, `"Order {oid} is not open (status: filled)"`.

### action.type: "cancelByCloid"

```json
{ "type": "cancelByCloid", "cancels": [{ "asset": 0, "cloid": "my-cloid" }] }
```
Error: `"cloid {cloid} not found"`.

### action.type: "updateLeverage"

```json
{ "type": "updateLeverage", "asset": 0, "isCross": true, "leverage": 20 }
```
Leverage range: **1–200**. Response: `{ "status": "ok", "response": { "type": "default" } }`.

---

## POST /info

Query market data and user state. Body: `{ "type": "...", ... }`

### type: "allMids"

```json
Request:  { "type": "allMids" }
Response: { "BTC": "50000.5", "ETH": "3000.25" }
```

### type: "clearinghouseState"

```json
Request:  { "type": "clearinghouseState", "user": "0x..." }
Response: {
  "assetPositions": [{
    "type": "oneWay",
    "position": {
      "coin": "BTC",
      "szi": "1.5",
      "entryPx": "50000",
      "positionValue": "75000",
      "unrealizedPnl": "1500",
      "returnOnEquity": "0.5",
      "liquidationPx": "49000",
      "leverage": { "type": "cross", "value": 20 },
      "cumFunding": { "allTime": "100", "sinceOpen": "50", "sinceChange": "10" },
      "maxLeverage": 50,
      "marginUsed": "3750"
    }
  }],
  "crossMarginSummary": {
    "accountValue": "101500",
    "totalNtlPos": "75000",
    "totalRawUsd": "100000",
    "totalMarginUsed": "3750"
  },
  "marginSummary": { /* same shape as crossMarginSummary */ },
  "crossMaintenanceMarginUsed": "1875",
  "withdrawable": "97750",
  "time": 1705000000000
}
```

### type: "openOrders"

```json
Request:  { "type": "openOrders", "user": "0x..." }
Response: [{
  "coin": "BTC", "side": "B", "limitPx": "49000", "sz": "1",
  "oid": 123, "timestamp": 1705000000000, "origSz": "1", "cloid": "optional"
}]
```

### type: "frontendOpenOrders"

Same as `openOrders` plus: `tif`, `orderType` ("Limit"|"Stop"), `triggerPx`, `triggerCondition`, `isPositionTpsl`, `reduceOnly`.

### type: "userFills"

```json
Request:  { "type": "userFills", "user": "0x..." }
Response: [{
  "coin": "BTC", "px": "50010", "sz": "1", "side": "B",
  "time": 1705000000000, "startPosition": "0",
  "dir": "Open Long",    // "Open Long"|"Close Long"|"Open Short"|"Close Short"
  "closedPnl": "0", "hash": "0x...", "oid": 123,
  "crossed": true, "fee": "0", "tid": 1000, "feeToken": "USDC"
}]
```
Returns up to **100** most recent fills.

### type: "userFillsByTime"

```json
{ "type": "userFillsByTime", "user": "0x...", "startTime": 1704900000000, "endTime": 1705000000000 }
```
`endTime` is optional. Same response shape as `userFills`.

### type: "orderStatus"

```json
Request:  { "type": "orderStatus", "oid": 12345 }
Response: {
  "status": "order",    // "order" | "unknownOid"
  "order": {
    "coin": "BTC", "side": "B", "limitPx": "49000", "sz": "1",
    "oid": 12345, "timestamp": 1705000000000, "origSz": "1",
    "tif": "Gtc", "orderType": "Limit",
    "status": "open",   // "open"|"filled"|"cancelled"|"triggered"|"rejected"
    "statusTimestamp": 1705000000000,
    "reduceOnly": false, "isPositionTpsl": false
  }
}
```

### type: "activeAssetCtx"

```json
Request:  { "type": "activeAssetCtx", "coin": "BTC" }
Response: {
  "coin": "BTC",
  "ctx": {
    "funding": "0.0001", "openInterest": "1000000", "prevDayPx": "49000",
    "dayNtlVlm": "500000000", "premium": "0.0005", "oraclePx": "50000",
    "markPx": "50010", "midPx": "50005.5", "impactPxs": ["50000", "50020"]
  }
}
```

### Proxied types (forwarded to HyperLiquid with caching)

| Type | Cache TTL |
|------|-----------|
| `meta` | 60s |
| `metaAndAssetCtxs` | 2s |
| `l2Book` | 1s |
| `candleSnapshot` | 5s |
| `fundingHistory` | 30s |
| `perpsAtOpenInterest` | 10s |
| `predictedFundings` | 10s |
| Other unknown types | 5s |

---

## POST /hypaper

Paper-trading-specific account management.

### type: "resetAccount"

Clears all positions, orders, fills. Resets balance to default.
```json
Request:  { "type": "resetAccount", "user": "0x..." }
Response: { "status": "ok", "message": "Account reset" }
```

### type: "setBalance"

```json
Request:  { "type": "setBalance", "user": "0x...", "balance": 500000 }
Response: { "status": "ok", "balance": "500000" }
```

### type: "getAccountInfo"

```json
Request:  { "type": "getAccountInfo", "user": "0x..." }
Response: { "userId": "0x...", "balance": "100000", "createdAt": 1705000000000 }
```

---

## WebSocket — /ws

Connect via `ws://localhost:3000/ws`. JSON messages only. 30s ping/pong heartbeat.

### Subscribe / Unsubscribe

```json
{ "method": "subscribe", "subscription": { "type": "allMids" } }
{ "method": "subscribe", "subscription": { "type": "l2Book", "coin": "BTC" } }
{ "method": "subscribe", "subscription": { "type": "orderUpdates", "user": "0x..." } }
{ "method": "subscribe", "subscription": { "type": "userFills", "user": "0x..." } }
```

Server confirms with:
```json
{ "channel": "subscriptionResponse", "data": { "method": "subscribe", "subscription": { "type": "allMids" } } }
```

**Snapshots on subscribe:** `allMids` and `l2Book` send an initial snapshot immediately. `orderUpdates` and `userFills` do not.

### Channel: allMids

```json
{ "channel": "allMids", "data": { "mids": { "BTC": "50000.5", "ETH": "3000.25" } } }
```

### Channel: l2Book

```json
{ "channel": "l2Book", "data": {
  "coin": "BTC",
  "levels": [
    [{ "px": "49999", "sz": "1.5", "n": 3 }],   // bids
    [{ "px": "50001", "sz": "2", "n": 4 }]        // asks
  ],
  "time": 1705000000000
}}
```

### Channel: orderUpdates

```json
{ "channel": "orderUpdates", "data": [{
  "order": { "coin": "BTC", "side": "B", "limitPx": "49000", "sz": "1", "oid": 123, "timestamp": 1705000000000 },
  "status": "open",   // "open"|"filled"|"cancelled"
  "statusTimestamp": 1705000000000
}]}
```

### Channel: userFills

```json
{ "channel": "userFills", "data": {
  "isSnapshot": false, "user": "0x...",
  "fills": [{ "coin": "BTC", "px": "50010", "sz": "1", "side": "B", "dir": "Open Long", ... }]
}}
```

---

## Key Details

### Order Matching

- Runs on every price update from HyperLiquid.
- **Limit orders**: Fill when `midPx <= limitPx` (buys) or `midPx >= limitPx` (sells).
- **Trigger (SL)**: Triggers when price moves against position (`midPx <= triggerPx` for sell SL).
- **Trigger (TP)**: Triggers when price moves in favor (`midPx >= triggerPx` for sell TP).

### Fill Price

- **VWAP** from L2 book (walks asks for buys, bids for sells).
- Clamped to limit price — never worse than your limit.
- Falls back to mid price if book unavailable.

### Margin

- `marginNeeded = (size × price) / leverage`
- `accountValue = balance + unrealizedPnl`
- `available = accountValue - totalMarginUsed`
- **reduceOnly** orders skip margin check.
- Default leverage: **20x cross**.

### PnL

- Long close: `(fillPx - entryPx) × closedSize`
- Short close: `(entryPx - fillPx) × closedSize`
- Closed PnL immediately credited to balance.

### Wire Field Mapping

| Wire | Meaning |
|------|---------|
| `a` | asset index |
| `b` | isBuy |
| `p` | limitPx |
| `s` | sz |
| `r` | reduceOnly |
| `t` | order type (tif + trigger) |
| `c` | cloid |
| `o` | oid (for cancels) |

### Error Reference

| Error | Cause |
|-------|-------|
| `"Missing wallet address"` | No `wallet` in body |
| `"Max 50 orders per request"` | Too many orders |
| `"Size and price must be positive"` | Bad `p` or `s` |
| `"Unknown asset {n}"` | Invalid asset index |
| `"IOC order could not be filled"` | IOC can't fill at limit |
| `"ALO order would have crossed"` | ALO would match |
| `"Insufficient margin"` | Not enough margin |
| `"Order {oid} not found"` | Bad OID or wrong owner |
| `"cloid {cloid} not found"` | Bad client order ID |
| `"Leverage must be between 1 and 200"` | Out of range |

### Rate Limiting

Default: **120 requests / 60s**. Returns HTTP 429 with `X-RateLimit-Remaining` header.
