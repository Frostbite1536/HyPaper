import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../config.js', () => ({
  config: {
    LM_ENABLED: true,
    LM_DEFAULT_BALANCE: 10_000,
    LM_API_URL: 'https://api.limitless.exchange',
    LM_RESOLVER_INTERVAL_MS: 60_000,
    LOG_LEVEL: 'silent',
  },
}));

let tidCounter = 100;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => 1),
  nextTid: vi.fn(async () => ++tidCounter),
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(),
  updateUserBalance: vi.fn(),
}));

// Mock the SDK market fetcher
const mockGetMarket = vi.fn();
vi.mock('@limitless-exchange/sdk', () => ({
  HttpClient: vi.fn(() => ({})),
  MarketFetcher: vi.fn(() => ({
    getMarket: mockGetMarket,
  })),
}));

// Mock cancelLmOrder (called during resolution to cancel open orders)
const mockCancelLmOrder = vi.fn(async () => ({ status: 'ok' }));
vi.mock('../engine/lm-order.js', () => ({
  cancelLmOrder: mockCancelLmOrder,
  ensureLmAccount: vi.fn(async () => undefined),
}));

// Create a fresh eventBus and LmOrderMatcher mock
const eventBus = new EventEmitter();
vi.mock('../worker/index.js', () => ({
  eventBus,
  lmOrderMatcher: { executeFill: vi.fn(async () => true) },
}));

const { LmResolver } = await import('../worker/lm-resolver.js');

const SLUG = 'test-market';
const USER = '0xuser1';
const USER2 = '0xuser2';

describe('LmResolver', () => {
  let resolver: InstanceType<typeof LmResolver>;
  let fillEvents: Array<{ userId: string; fill: any }>;

  beforeEach(() => {
    redisMock.flushall();
    tidCounter = 100;
    mockGetMarket.mockReset();
    mockCancelLmOrder.mockReset();

    resolver = new LmResolver(eventBus);
    fillEvents = [];
    eventBus.removeAllListeners('lm:fill');
    eventBus.on('lm:fill', (e) => fillEvents.push(e));
  });

  async function seedUserWithPosition(
    userId: string,
    slug: string,
    yesBalance: string,
    noBalance: string,
    yesCost = '0',
    noCost = '0',
  ) {
    await redisMock.sadd(KEYS.LM_USERS_ACTIVE, userId);
    await redisMock.sadd(KEYS.LM_USER_POSITIONS(userId), slug);
    await redisMock.hset(KEYS.LM_USER_POS(userId, slug),
      'yesBalance', yesBalance,
      'noBalance', noBalance,
      'yesCost', yesCost,
      'noCost', noCost,
    );
    await redisMock.hset(KEYS.LM_USER_ACCOUNT(userId),
      'userId', userId, 'balance', '1000', 'createdAt', '0',
    );
  }

  async function seedMarketData(slug: string) {
    await redisMock.hset(KEYS.LM_MARKETS, slug, JSON.stringify({ slug, status: 'FUNDED' }));
    await redisMock.hset(KEYS.LM_MARKET_PRICES, slug, JSON.stringify({ yes: '0.60', no: '0.40' }));
  }

  it('credits YES winners when YES wins (winningOutcomeIndex=0)', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 0 });

    // Access private method via casting
    await (resolver as any).checkResolutions();

    // Balance should be credited with payout (100 YES tokens × $1)
    const account = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBe(1100); // 1000 + 100

    // Position should be cleaned up
    const pos = await redisMock.hgetall(KEYS.LM_USER_POS(USER, SLUG));
    expect(Object.keys(pos)).toHaveLength(0);

    // Fill event should have been emitted
    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.outcome).toBe('yes');
    expect(fillEvents[0].fill.side).toBe('resolution');
    expect(fillEvents[0].fill.price).toBe('1');
  });

  it('credits NO winners when NO wins (winningOutcomeIndex=1)', async () => {
    await seedUserWithPosition(USER, SLUG, '0', '50', '0', '20');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 1 });

    await (resolver as any).checkResolutions();

    const account = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBe(1050); // 1000 + 50

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.outcome).toBe('no');
    expect(fillEvents[0].fill.price).toBe('1');
  });

  it('losers get zero payout', async () => {
    // User holds YES tokens but NO wins
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 1 }); // NO wins

    await (resolver as any).checkResolutions();

    // Balance unchanged (payout is '0', only losing tokens)
    const account = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBe(1000);

    // Fill still emitted for record-keeping
    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.price).toBe('0');
  });

  it('resolves multiple users in same market', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedUserWithPosition(USER2, SLUG, '0', '50', '0', '20');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 0 }); // YES wins

    await (resolver as any).checkResolutions();

    // USER (YES holder) gets payout
    const account1 = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER));
    expect(parseFloat(account1.balance)).toBe(1100);

    // USER2 (NO holder) gets nothing
    const account2 = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER2));
    expect(parseFloat(account2.balance)).toBe(1000);

    expect(fillEvents).toHaveLength(2);
  });

  it('skips invalid winningOutcomeIndex (not 0 or 1)', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 2 }); // Invalid!

    await (resolver as any).checkResolutions();

    // Balance unchanged — resolution was skipped
    const account = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBe(1000);

    // Position still exists
    const pos = await redisMock.hgetall(KEYS.LM_USER_POS(USER, SLUG));
    expect(pos.yesBalance).toBe('100');

    expect(fillEvents).toHaveLength(0);
  });

  it('skips unresolved markets (winningOutcomeIndex null)', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: null });

    await (resolver as any).checkResolutions();

    // Nothing changed
    const account = await redisMock.hgetall(KEYS.LM_USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBe(1000);
    expect(fillEvents).toHaveLength(0);
  });

  it('cancels open orders for resolved market', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);

    // Seed an open order for this market
    const oid = 42;
    await redisMock.sadd(KEYS.LM_ORDERS_OPEN, oid.toString());
    await redisMock.hset(KEYS.LM_ORDER(oid),
      'oid', oid.toString(), 'userId', USER,
      'marketSlug', SLUG, 'status', 'open',
      'outcome', 'yes', 'side', 'buy',
      'price', '0.50', 'size', '10',
      'orderType', 'limit',
    );

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 0 });
    mockCancelLmOrder.mockResolvedValueOnce({ status: 'ok' });

    await (resolver as any).checkResolutions();

    expect(mockCancelLmOrder).toHaveBeenCalledWith(USER, oid);
  });

  it('cleans up market data after resolution', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);
    await redisMock.set(KEYS.LM_MARKET_ORDERBOOK(SLUG), '{}');

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 0 });

    await (resolver as any).checkResolutions();

    // Market data should be removed
    const marketExists = await redisMock.hexists(KEYS.LM_MARKETS, SLUG);
    expect(marketExists).toBe(0);

    const priceExists = await redisMock.hexists(KEYS.LM_MARKET_PRICES, SLUG);
    expect(priceExists).toBe(0);

    const orderbook = await redisMock.get(KEYS.LM_MARKET_ORDERBOOK(SLUG));
    expect(orderbook).toBeNull();
  });

  it('removes user from active set when no positions remain', async () => {
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 0 });

    await (resolver as any).checkResolutions();

    const activeUsers = await redisMock.smembers(KEYS.LM_USERS_ACTIVE);
    expect(activeUsers).not.toContain(USER);
  });

  it('calculates correct PnL (payout minus cost)', async () => {
    // Bought 100 YES at $0.60 each = cost $60
    await seedUserWithPosition(USER, SLUG, '100', '0', '60', '0');
    await seedMarketData(SLUG);

    mockGetMarket.mockResolvedValueOnce({ winningOutcomeIndex: 0 });

    await (resolver as any).checkResolutions();

    // PnL = payout (100) - totalCost (60) = 40
    expect(fillEvents[0].fill.closedPnl).toBe('40');
  });
});
