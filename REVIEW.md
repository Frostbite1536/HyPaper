# Code Review Guidelines

Review rules specific to HyPaper. Read alongside `CLAUDE.md` and `docs/INVARIANTS.md`.

## Always Check

### Financial Math
- No JavaScript `number` for prices, sizes, balances, costs, PnL, or fees
- All arithmetic uses `src/utils/math.ts` helpers (`add`, `sub`, `mul`, `div`)
- NaN and Infinity are validated before writing to Redis
- String decimal values survive Redis read/write without coercion

### Namespace Isolation
- HL code (no `lm-` prefix) never reads/writes `lm:*` Redis keys
- LM code (`lm-` prefix) never reads/writes `market:*`, `order:*`, `user:*` keys
- New Redis keys are defined in `src/store/keys.ts`

### State Machine Compliance
- Order status transitions follow `docs/STATE_MACHINES.md`
- `status === 'open'` checked before any fill or cancel
- Terminal states (`filled`, `cancelled`, `rejected`) are never mutated

### Atomicity
- Balance changes + position updates + order status updates are in the same Redis pipeline
- No `await` of Postgres operations in the fill path
- Rollback logic for failed atomic operations (e.g., insufficient balance)

### Event Completeness
- State changes that affect user-visible data emit EventBus events
- New event types are defined in `src/ws/types.ts`
- pg-sink handles the new event in `src/store/pg-sink.ts`

### API Validation
- Request body parsed with try-catch (handle malformed JSON)
- All user-provided values validated for type and range before reaching the engine
- `NaN`, `Infinity`, negative values, and wrong types rejected with 400

## Severity Tags

- **[CRITICAL]**: Bug that causes incorrect balances, fills, or data corruption. Must fix before merge.
- **[NIT]**: Minor issue, worth fixing but not blocking. Style, naming, minor inefficiency.
- **[PRE-EXISTING]**: Bug not introduced by this PR. File separately.

## Skip

- Generated files under `dist/`
- `node_modules/`
- Formatting-only changes in lock files
- Docs-only PRs (unless they document incorrect behavior)

## Known Accepted Risks (Paper Trading)

These are documented in `docs/INVARIANTS.md` and acceptable for paper trading scope:

- No authentication (wallet address = identity)
- Single-process, single-threaded (no HA)
- Redis data loss on restart (paper money, no real value)
- Race conditions in narrow async gaps (self-correcting, not exploitable)
