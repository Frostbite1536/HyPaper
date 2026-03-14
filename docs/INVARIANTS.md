# System Invariants & Contracts

## Purpose

These are the **non-negotiable truths** of HyPaper. If a change violates an invariant, it is a bug — never an implementation detail.

**If a change violates an invariant, it is a bug or a product decision — never an implementation detail.**

## How to Use This Document

1. **Before implementing any feature**: Review this document to ensure compliance
2. **During code review**: Check that changes respect all invariants
3. **When debugging**: Verify that invariants still hold
4. **When changing an invariant**: Document why, get explicit approval, update tests

---

## Data Integrity Invariants

### INV-DATA-001: Decimal Precision

**Rule**: All monetary values (prices, sizes, balances, PnL, costs, fees) must use `string` representation and `decimal.js` for arithmetic. Never use JavaScript `number` for financial math.

**Rationale**: Floating-point errors accumulate over many trades (`0.1 + 0.2 !== 0.3`), causing balance drift.

**Examples**:
- Valid: `add('100.50', '0.0035')` → `'100.5035'`
- Invalid: `100.50 + 0.0035` → `100.5035000000000001`

**Enforcement**: Use `src/utils/math.ts` helpers (`D()`, `add()`, `sub()`, `mul()`, `div()`). All Redis fields and Postgres columns storing money use `text` type.

**Known Violations**: None (fixed 2026-03-13)

### INV-DATA-002: LM Price Bounds

**Rule**: Limitless market prices must always be in range `[0.01, 0.99]`. YES price + NO price = 1.00. Any price outside this range is invalid and must be rejected or clamped.

**Rationale**: Prediction market prices represent probabilities. 0 and 1 are degenerate (certain outcomes don't need a market).

**Examples**:
- Valid: YES = `0.65`, NO = `0.35`
- Invalid: YES = `1.05`, NO = `-0.05`
- Invalid: YES = `NaN`, NO = `NaN`

**Enforcement**: `clampPrice()` in `lm-price-updater.ts` clamps to [0.01, 0.99]. `lm-order.ts` validates order price is in [0.01, 0.99].

**Known Violations**: None (fixed 2026-03-13 — `clampPrice()` now checks `isFinite()` before clamping)

### INV-DATA-003: Balance Non-Negativity

**Rule**: A user's balance can never go negative. A user's token balance can never go negative. BUY orders require `balance >= price * size`. SELL orders require `tokenBalance >= size`.

**Rationale**: Paper trading should not create phantom money.

**Examples**:
- Valid: Balance `1000`, buy 10 shares at `0.50` → balance `995`
- Invalid: Balance `4`, buy 10 shares at `0.50` → balance `-1`

**Enforcement**:
- HL: Margin check in `engine/margin.ts` before order placement
- LM: Atomic `HINCRBYFLOAT` + rollback pattern in `lm-order-matcher.ts`

### INV-DATA-004: Redis-Postgres Consistency

**Rule**: Redis is the source of truth for all hot state. Postgres is append-only historical storage. Postgres writes must never block the trading path.

**Rationale**: Order matching must complete in microseconds. Database contention would break this.

**Examples**:
- Valid: Fill executes in Redis, EventBus emits `fill`, pg-sink writes async
- Invalid: Fill executes, `await db.insert(fills).values(...)`, then updates Redis

**Enforcement**: `pg-sink.ts` subscribes to EventBus events. No `await` of Postgres operations in engine or matcher code.

---

## Namespace Isolation Invariants

### INV-NS-001: Key Namespace Isolation

**Rule**: All Limitless Redis keys use the `lm:` prefix. HL keys use `market:*`, `order:*`, `user:*` prefixes. HL code must never read/write `lm:*` keys. LM code must never read/write HL-namespaced keys.

**Rationale**: Prevents cross-contamination between the two exchange backends. A bug in LM should never corrupt HL state.

**Examples**:
- Valid: LM order matcher reads `lm:prices` for price data
- Invalid: LM order matcher reads `market:mids` for price data

**Enforcement**: All keys defined in `src/store/keys.ts`. Code review.

### INV-NS-002: Shared Sequence IDs

**Rule**: `seq:oid` and `seq:tid` are shared between HL and LM. Order IDs and trade IDs are globally unique but not exchange-specific.

**Rationale**: Simplifies ID generation. No risk of collision.

**Enforcement**: Both engines call `nextOid()` / `nextTid()` from `src/utils/id.ts`.

---

## Order State Invariants

### INV-ORD-001: Terminal State Immutability

**Rule**: Once an order reaches `filled`, `cancelled`, or `rejected` status, it must never be modified. No field changes, no status transitions.

**Rationale**: Filled orders are historical records. Modifying them would corrupt trade history and PnL calculations.

**Examples**:
- Valid: Order `filled` → remains `filled` forever
- Invalid: Order `filled` → `cancelled` (attempting to undo a fill)

**Enforcement**: Check `status === 'open'` before any fill or cancel operation.

**Known Violations**: None (fixed 2026-03-13 — `executeFill()` now rechecks `order.status` from Redis before filling)

### INV-ORD-002: Open Order Set Consistency

**Rule**: An order's `oid` is in the `orders:open` (or `lm:orders:open`) set if and only if its status is `open`.

**Rationale**: The matcher iterates the open set. Stale entries cause wasted work or incorrect fills.

**Enforcement**: Add to set on placement, remove on fill/cancel/reject in the same pipeline.

### INV-ORD-003: Fill-Position Atomicity

**Rule**: When an order fills, the balance deduction, position update, and order status update must happen atomically (within a single Redis pipeline).

**Rationale**: Partial state after a crash leaves the system inconsistent.

**Enforcement**: Redis pipelines in `order-matcher.ts` and `lm-order-matcher.ts`.

---

## Cross-Component Contract Invariants

### INV-XCOMP-001: Price Data Validity

**Rule**: Price data written to Redis must be valid numeric strings. `"NaN"`, `"Infinity"`, `"undefined"`, and `"null"` are never valid prices.

**Rationale**: NaN propagates silently through decimal.js comparisons (always returns `false`), causing orders to never fill or to fill at invalid prices.

**Examples**:
- Valid: `{"yes":"0.65","no":"0.35"}`
- Invalid: `{"yes":"NaN","no":"NaN"}`

**Enforcement**: Validate inputs before writing to Redis. The order matcher should also validate prices read from Redis before using them.

**Known Violations**: None (fixed 2026-03-13 — `clampPrice()` validates `isFinite()`, `executeFill()` validates fill price)

### INV-XCOMP-002: Type Consistency Across Layers

**Rule**: Monetary values are `string` in Redis, `string` in TypeScript interfaces, and `text` in Postgres. Never `number`/`float`/`numeric`.

**Rationale**: Type leakage (`Number('0.1') + Number('0.2')`) silently corrupts data.

**Enforcement**: TypeScript interfaces define all monetary fields as `string`. Drizzle schema uses `text()` for monetary columns.

### INV-XCOMP-003: EventBus Event Completeness

**Rule**: Every state change that affects user-visible data (fills, order updates, balance changes) must emit a corresponding EventBus event for pg-sink and WebSocket consumers.

**Rationale**: If an event is not emitted, Postgres history and WebSocket clients become stale.

**Known Violations**: None (fixed 2026-03-13 — `funding-worker.ts` now emits `funding` event per charge)

### INV-XCOMP-004: Resolution Outcome Bounds

**Rule**: `winningOutcomeIndex` must be `0` (YES wins) or `1` (NO wins). Any other value is invalid and must be rejected.

**Rationale**: The resolver maps `0` → `'yes'` and anything else → `'no'` via a ternary. An unexpected value like `2` would incorrectly resolve as `'no'`.

**Known Violations**: None (fixed 2026-03-13 — `lm-resolver.ts` now validates index is 0 or 1)

---

## API Contract Invariants

### INV-API-001: HL Wire Format Compatibility

**Rule**: `/exchange` and `/info` endpoints must accept and return data in the exact format documented by HyperLiquid's API. Field names, types, and nesting must match.

**Rationale**: Existing HL bots depend on wire-format compatibility.

**Enforcement**: TypeScript types in `src/types/hl.ts` mirror HL's API shapes. Integration test via `npm run test:realtime`.

### INV-API-002: Request Body Validation

**Rule**: All API routes must validate request body types before processing. Invalid input must return a 400 error, never propagate to the engine.

**Rationale**: Unvalidated input can cause NaN propagation, type errors, or undefined behavior in the engine.

**Known Violations**: None (fixed 2026-03-13 — all routes now validate inputs with try-catch and NaN/Infinity guards)

---

## Performance Invariants

### INV-PERF-001: No Blocking on Postgres

**Rule**: The order matching and fill execution path must never `await` a Postgres operation.

**Rationale**: Postgres latency would directly impact order matching speed.

**Enforcement**: All Postgres writes go through `pg-sink.ts` via EventBus (fire-and-forget).

### INV-PERF-002: Order Matching on Every Tick

**Rule**: `matchAll()` runs on every price update. It must complete before the next price update arrives.

**Rationale**: Stale matching means orders don't fill at the correct price.

**Enforcement**: Single-threaded Node.js event loop. Price updates trigger matching synchronously.

---

## Invariant Violation Log

| Date | Invariant | Status | Description |
|------|-----------|--------|-------------|
| 2026-03-13 | INV-DATA-002 | FIXED | `clampPrice()` now validates `isFinite()` before clamping |
| 2026-03-13 | INV-ORD-001 | FIXED | `executeFill()` rechecks order status from Redis |
| 2026-03-13 | INV-XCOMP-001 | FIXED | `clampPrice()` and `executeFill()` reject non-finite prices |
| 2026-03-13 | INV-XCOMP-003 | FIXED | `funding-worker.ts` emits `funding` event per charge |
| 2026-03-13 | INV-XCOMP-004 | FIXED | `lm-resolver.ts` validates index is 0 or 1 |
| 2026-03-13 | INV-API-002 | FIXED | All routes validate inputs: try-catch, NaN/Infinity guards |
| 2026-03-13 | INV-DATA-001 | FIXED | `lm-order.ts` uses Decimal, `lm-order-matcher.ts` uses `lt()` |

---

**Last Updated**: 2026-03-13
**Reviewed By**: Claude Code audit (Passes 1-3)
