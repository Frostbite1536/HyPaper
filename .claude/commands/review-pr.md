You are performing a structured code review of HyPaper. Find correctness bugs,
security vulnerabilities, broken edge cases, and subtle regressions —
not formatting preferences or style nits (unless they violate explicit
rules in REVIEW.md).

**What to review**: $ARGUMENTS

If a PR number was provided, fetch the diff and changed files.
If no argument was given, review changes on the current branch against main.

## Step 1: Gather Context

1. **The diff**: Use `gh pr diff <number>` for PRs, or `git diff main...HEAD` for local branches
2. **Changed files in full**: Read each changed file completely — not just the diff
3. **CLAUDE.md**: Read for general project rules
4. **REVIEW.md**: Read for review-specific rules
5. **docs/INVARIANTS.md**: Read for system invariants

## Step 2: Multi-Pass Analysis

### Pass 1 — Financial Correctness
- All prices, sizes, balances use string decimals and `math.ts` helpers
- No JavaScript `Number()` or `parseFloat()` on monetary values
- NaN/Infinity validation before Redis writes
- Balance can never go negative
- LM prices always in [0.01, 0.99]
- Division by zero guarded

### Pass 2 — State Machine Compliance
- Order transitions follow docs/STATE_MACHINES.md
- Terminal states are never mutated
- `status === 'open'` checked before fills and cancels
- Redis set membership matches order status

### Pass 3 — Namespace Isolation
- HL code never touches `lm:*` keys
- LM code never touches `market:*`, `order:*`, `user:*` keys
- New keys added to `src/store/keys.ts`

### Pass 4 — Atomicity & Consistency
- Balance + position + order updates in same Redis pipeline
- No `await` on Postgres in the fill path
- EventBus events emitted for all user-visible state changes
- pg-sink handles new events

### Pass 5 — API Validation
- Request body parsed with try-catch
- All user inputs validated for type and range
- NaN, Infinity, wrong types rejected with 400
- No command injection, path traversal, or XSS

### Pass 6 — Regression Pattern Search
- For each bug found, search codebase for the same pattern elsewhere
- Check if test fixtures reflect any new fields or changed semantics

## Step 3: Report

Tag each finding:
- **[CRITICAL]**: Bug that should be fixed before merging
- **[NIT]**: Minor issue, worth fixing but not blocking
- **[PRE-EXISTING]**: Bug not introduced by this PR

Format:
**[SEVERITY] File: `path/to/file` | Line: N**
**Issue**: Description.
**Why**: Failure scenario.
**Fix**: Suggested fix.

End with a summary: total findings, key concerns, overall assessment.
If no issues found: "Code review complete. No issues found."
