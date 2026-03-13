# HyPaper State Machines

This document defines every state machine in HyPaper. Any transition not listed here is a bug.

---

## 1. HL Order State Machine

**Redis key**: `order:{oid}` (field: `status`)

```
                     ┌─────────────┐
                     │   (created)  │
                     └──────┬──────┘
                            │
                   placeOrders()
                            │
                ┌───────────┼───────────┐
                │           │           │
          (IOC rejects) (fills now) (rests on book)
                │           │           │
                ▼           ▼           ▼
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │ rejected │ │  filled  │ │   open   │
         └──────────┘ └──────────┘ └────┬─────┘
                                        │
                              ┌─────────┼─────────┐
                              │                   │
                        (price crosses)    (user cancels)
                              │                   │
                              ▼                   ▼
                        ┌──────────┐        ┌───────────┐
                        │  filled  │        │ cancelled │
                        └──────────┘        └───────────┘
```

### States

| State | Description |
|-------|-------------|
| `open` | Resting on book, waiting for price match |
| `filled` | Completely filled (no partial fills in HL engine) |
| `cancelled` | Cancelled by user or system |
| `rejected` | Rejected at placement (IOC that can't fill, ALO that would cross) |

### Valid Transitions

| From | To | Trigger | Code Location |
|------|----|---------|---------------|
| (new) | `open` | Order placed, doesn't fill immediately | `engine/order.ts:placeOrders()` |
| (new) | `filled` | Order placed, fills immediately (GTC/IOC cross) | `engine/order.ts:placeOrders()` |
| (new) | `rejected` | IOC can't fill, ALO would cross | `engine/order.ts:placeOrders()` |
| `open` | `filled` | Price crosses limit price on tick | `worker/order-matcher.ts:matchAll()` |
| `open` | `cancelled` | User sends cancel request | `engine/order.ts:cancelOrders()` |

### Trigger Order Sub-States

Trigger orders (TP/SL) have an additional `isTriggered` field:

```
  open (isTriggered=false)  ──trigger price hit──>  open (isTriggered=true)  ──limit fills──>  filled
```

When `isTriggered` flips to `true`, the trigger order becomes a regular limit order and enters the normal matching flow.

### Invariants

- Once `filled` or `cancelled` or `rejected`, the order is **immutable**
- `filledSz` only changes at the `open` → `filled` transition
- `open` orders are in the `orders:open` Redis set; filled/cancelled are not
- Trigger orders (`orders:triggers` set) move to `orders:open` upon triggering

---

## 2. LM Order State Machine

**Redis key**: `lm:order:{oid}` (field: `status`)

```
                     ┌─────────────┐
                     │   (created)  │
                     └──────┬──────┘
                            │
                   placeLmOrder()
                            │
                ┌───────────┼───────────┐
                │           │           │
         (market, no fill) (rests)   (rejected)
                │           │           │
                ▼           ▼           ▼
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │ rejected │ │   open   │ │ rejected │
         └──────────┘ └────┬─────┘ └──────────┘
                           │
                 ┌─────────┼─────────┐
                 │                   │
           (price crosses)    (user cancels /
                 │             market resolves)
                 ▼                   ▼
           ┌──────────┐        ┌───────────┐
           │  filled  │        │ cancelled │
           └──────────┘        └───────────┘
```

### States

| State | Description |
|-------|-------------|
| `open` | Resting, waiting for price match |
| `filled` | Completely filled |
| `cancelled` | Cancelled by user or by resolver on market resolution |
| `rejected` | Rejected at placement (insufficient balance, market not active, FOK market order can't fill) |

### Valid Transitions

| From | To | Trigger | Code Location |
|------|----|---------|---------------|
| (new) | `open` | Limit order placed | `engine/lm-order.ts:placeLmOrder()` |
| (new) | `rejected` | Validation fails or market order can't fill | `engine/lm-order.ts:placeLmOrder()` |
| `open` | `filled` | Market price crosses order price | `worker/lm-order-matcher.ts:executeFill()` |
| `open` | `cancelled` | User cancels | `engine/lm-order.ts:cancelLmOrder()` |
| `open` | `cancelled` | Market resolves | `worker/lm-resolver.ts:resolveMarket()` |

### Invariants

- Once `filled`, `cancelled`, or `rejected`, the order is **immutable**
- `open` orders are in the `lm:orders:open` Redis set
- Only one fill per order (no partial fills)

---

## 3. LM Market State Machine

**External state from Limitless API** (field: `status` in cached market data)

```
   CREATED  ──>  FUNDED  ──>  RESOLVED
                    │
                    └──>  DISPUTED (rare)
```

### States

| State | Description | HyPaper Behavior |
|-------|-------------|------------------|
| `CREATED` | Market exists but not yet funded | Skipped during market seeding |
| `FUNDED` | Active, tradeable | Orders accepted, prices tracked |
| `RESOLVED` | Outcome determined | Positions settled, market cleaned up |
| `DISPUTED` | Resolution challenged | Treated like FUNDED (no special handling) |

### HyPaper-Relevant Transitions

| From | To | Trigger | Code Location |
|------|----|---------|---------------|
| `FUNDED` | `RESOLVED` | `winningOutcomeIndex` set in API response | `worker/lm-resolver.ts` |

### Resolution Process

1. Resolver detects `winningOutcomeIndex != null`
2. For each user with a position in this market:
   - Winning shares: credit `$1 × balance` to user account
   - Losing shares: credit `$0`
   - Delete position from Redis
3. Cancel all open orders for this market
4. Remove market from `lm:markets`, `lm:prices`, `lm:ob:{slug}`

---

## 4. HL Position Lifecycle

Positions are not a state machine per se, but have a clear lifecycle:

```
   (no position)  ──open trade──>  (position exists)  ──close trade──>  (no position)
                                         │
                                    partial close
                                         │
                                   (position resized)
```

### Fields that change

| Event | Changed Fields |
|-------|---------------|
| Open new position | `szi`, `entryPx`, `leverage`, `marginUsed` created |
| Increase position | `szi` increases, `entryPx` recalculated (weighted avg), `marginUsed` increases |
| Partial close | `szi` decreases, `marginUsed` decreases, realized PnL credited |
| Full close | Position hash deleted, realized PnL credited |
| Funding tick | `cumFunding`, `cumFundingSinceOpen`, `cumFundingSinceChange` updated |

### Invariants

- Position exists in Redis iff `user:{id}:positions` set contains the asset
- `szi > 0` = long, `szi < 0` = short
- `marginUsed = abs(szi) * entryPx / leverage`

---

## 5. LM Position Lifecycle

```
   (no position)  ──buy YES/NO──>  (position exists)  ──sell all──>  (no position)
                                          │                               ▲
                                     partial sell                         │
                                          │                          resolution
                                   (position resized)  ───────────────────┘
```

### Fields that change

| Event | Changed Fields |
|-------|---------------|
| Buy YES tokens | `yesBalance` +, `yesCost` +, `yesAvgPrice` recalculated |
| Buy NO tokens | `noBalance` +, `noCost` +, `noAvgPrice` recalculated |
| Sell YES tokens | `yesBalance` -, `yesCost` -, realized PnL credited |
| Sell NO tokens | `noBalance` -, `noCost` -, realized PnL credited |
| Market resolves | Position deleted, payout credited to balance |

### Invariants

- Position exists iff `lm:user:{id}:positions` set contains the market slug
- `yesBalance >= 0` and `noBalance >= 0` always
- `yesAvgPrice = yesCost / yesBalance` (when `yesBalance > 0`)
- Position deleted when both `yesBalance` and `noBalance` are zero

---

## 6. User Account Lifecycle

```
   (does not exist)  ──first API call──>  (exists with default balance)
                                                    │
                                              trade / funding
                                                    │
                                              (balance changes)
                                                    │
                                              resetAccount
                                                    │
                                          (balance reset, all data wiped)
```

Accounts are auto-created by `ensureAccount` middleware on first use. Both HL and LM have separate account hashes but share the same wallet-based `userId`.

---

## 7. WebSocket Connection Lifecycle

```
   (client connects)  ──>  (connected, no subs)
          │
    subscribe(channel)
          │
    (subscribed to N channels)
          │
    ┌─────┼──────┐
    │            │
  unsubscribe  disconnect
    │            │
  (N-1 subs)  (cleaned up)
```

Server tracks subscriptions per connection. On disconnect, all subscriptions are cleaned up automatically.

---

## Summary of Terminal States

| Entity | Terminal States | Can Be Resurrected? |
|--------|----------------|---------------------|
| HL Order | `filled`, `cancelled`, `rejected` | No |
| LM Order | `filled`, `cancelled`, `rejected` | No |
| LM Market | `RESOLVED` | No (deleted from Redis) |
| HL Position | deleted (fully closed) | Yes (new trade opens new position) |
| LM Position | deleted (sold all or resolved) | Yes (new trade opens new position) |
| User Account | N/A (always exists once created) | Reset via `/hypaper` or `/lm/hypaper` |
