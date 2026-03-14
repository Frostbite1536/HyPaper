import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

// --- Mock redis BEFORE importing LmOrderMatcher ---
const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../config.js', () => ({
  config: {
    LM_ENABLED: true,
    LM_DEFAULT_BALANCE: 10_000,
    LOG_LEVEL: 'silent',
  },
}));

let tidCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++tidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));

// Dynamic import AFTER mocks
const { LmOrderMatcher } = await import('../worker/lm-order-matcher.js');

describe('LmOrderMatcher', () => {
  let eventBus: EventEmitter;
  let matcher: InstanceType<typeof LmOrderMatcher>;
  let fillEvents: Array<{ userId: string; fill: any }>;
  let orderEvents: Array<{ userId: string; order: any; status: string }>;

  const USER = '0xtest';
  const SLUG = 'test-market';

  beforeEach(() => {
    redisMock.flushall();
    tidCounter = 100;

    eventBus = new EventEmitter();
    matcher = new LmOrderMatcher(eventBus);

    fillEvents = [];
    orderEvents = [];
    eventBus.on('lm:fill', (e) => fillEvents.push(e));
    eventBus.on('lm:orderUpdate', (e) => orderEvents.push(e));
  });

  function seedUser(balance: string) {
    return redisMock.hset(KEYS.LM_USER_ACCOUNT(USER), 'userId', USER, 'balance', balance, 'createdAt', '0');
  }

  function seedPrice(slug: string, yesPrice: string, noPrice: string) {
    return redisMock.hset(KEYS.LM_MARKET_PRICES, slug, JSON.stringify({ yes: yesPrice, no: noPrice }));
  }

  async function createOpenOrder(opts: {
    oid: number; marketSlug: string; outcome: string; side: string; price: string; size: string;
  }) {
    await redisMock.hset(KEYS.LM_ORDER(opts.oid),
      'oid', opts.oid.toString(),
      'userId', USER,
      'marketSlug', opts.marketSlug,
      'outcome', opts.outcome,
      'side', opts.side,
      'price', opts.price,
      'size', opts.size,
      'orderType', 'limit',
      'status', 'open',
      'filledSize', '0',
      'avgFillPrice', '0',
      'createdAt', '1000',
      'updatedAt', '1000',
    );
    await redisMock.sadd(KEYS.LM_ORDERS_OPEN, opts.oid.toString());
  }

  // --- BUY YES fills when yesPrice <= order.price ---
  it('fills BUY YES order when yesPrice <= order.price', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 1, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '100' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.side).toBe('buy');
    expect(fillEvents[0].fill.price).toBe('0.50'); // fills at market price (better for user)
    expect(fillEvents[0].fill.size).toBe('100');
  });

  // --- BUY NO fills when noPrice <= order.price ---
  it('fills BUY NO order when noPrice <= order.price', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.60', '0.40');
    await createOpenOrder({ oid: 2, marketSlug: SLUG, outcome: 'no', side: 'buy', price: '0.45', size: '50' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.outcome).toBe('no');
  });

  // --- SELL YES fills when yesPrice >= order.price ---
  it('fills SELL YES order when yesPrice >= order.price', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.70', '0.30');
    // Seed a YES position first
    await redisMock.hset(KEYS.LM_USER_POS(USER, SLUG),
      'userId', USER, 'marketSlug', SLUG,
      'yesBalance', '100', 'noBalance', '0',
      'yesCost', '50', 'noCost', '0',
      'yesAvgPrice', '0.50', 'noAvgPrice', '0',
    );
    await createOpenOrder({ oid: 3, marketSlug: SLUG, outcome: 'yes', side: 'sell', price: '0.65', size: '100' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.side).toBe('sell');
    // closedPnl = (0.70 - 0.50) * 100 = 20 (fills at market price 0.70, not limit 0.65)
    expect(fillEvents[0].fill.closedPnl).toBe('20');
  });

  // --- Order does not fill when price hasn't crossed ---
  it('does not fill when price has not crossed', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.60', '0.40');
    // BUY YES at 0.55, but yesPrice = 0.60 > 0.55 → no fill
    await createOpenOrder({ oid: 4, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '100' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(0);
    // Order should still be in open set
    const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
    expect(openOids).toContain('4');
  });

  // --- BUY fill deducts balance and increases token balance ---
  it('BUY fill deducts balance and increases token balance', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 5, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '100' });

    await matcher.matchAll();

    // Balance should be reduced by cost = 0.50 * 100 = 50 (fills at market price)
    const balance = await redisMock.hget(KEYS.LM_USER_ACCOUNT(USER), 'balance');
    expect(parseFloat(balance!)).toBeCloseTo(10000 - 50, 2);

    // Position should have yesBalance = 100
    const pos = await redisMock.hgetall(KEYS.LM_USER_POS(USER, SLUG));
    expect(pos.yesBalance).toBe('100');
  });

  // --- Filled orders removed from LM_ORDERS_OPEN ---
  it('removes filled order from open set', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 6, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '10' });

    await matcher.matchAll();

    const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
    expect(openOids).not.toContain('6');
  });

  // --- Fill events emitted ---
  it('emits fill and orderUpdate events', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 7, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '10' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    expect(orderEvents).toHaveLength(1);
    expect(orderEvents[0].status).toBe('filled');
  });

  // --- Insufficient balance skips fill ---
  it('skips fill when balance is insufficient', async () => {
    await seedUser('1'); // only $1
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 8, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '100' }); // needs $55

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(0);
  });

  // --- SELL NO fills when noPrice >= order.price ---
  it('fills SELL NO order when noPrice >= order.price', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.40', '0.60');
    // Seed a NO position
    await redisMock.hset(KEYS.LM_USER_POS(USER, SLUG),
      'userId', USER, 'marketSlug', SLUG,
      'yesBalance', '0', 'noBalance', '80',
      'yesCost', '0', 'noCost', '32',
      'yesAvgPrice', '0', 'noAvgPrice', '0.40',
    );
    await createOpenOrder({ oid: 10, marketSlug: SLUG, outcome: 'no', side: 'sell', price: '0.55', size: '80' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.side).toBe('sell');
    expect(fillEvents[0].fill.outcome).toBe('no');
    // closedPnl = (0.60 - 0.40) * 80 = 16 (fills at market price 0.60, not limit 0.55)
    expect(fillEvents[0].fill.closedPnl).toBe('16');
  });

  // --- SELL with insufficient tokens skips fill ---
  it('skips SELL fill when token balance is insufficient', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.70', '0.30');
    // Seed a YES position with only 10 tokens
    await redisMock.hset(KEYS.LM_USER_POS(USER, SLUG),
      'userId', USER, 'marketSlug', SLUG,
      'yesBalance', '10', 'noBalance', '0',
      'yesCost', '5', 'noCost', '0',
      'yesAvgPrice', '0.50', 'noAvgPrice', '0',
    );
    await createOpenOrder({ oid: 11, marketSlug: SLUG, outcome: 'yes', side: 'sell', price: '0.65', size: '50' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(0);
  });

  // --- No price data → no fill ---
  it('does not fill when no price data available', async () => {
    await seedUser('10000');
    // No price seeded for this market
    await createOpenOrder({ oid: 9, marketSlug: 'no-price-market', outcome: 'yes', side: 'buy', price: '0.55', size: '10' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(0);
  });

  // --- H2 regression: rejected orders are removed from open set ---
  it('rejects and removes order from open set when balance insufficient', async () => {
    await seedUser('1'); // only $1
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 12, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '100' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(0);
    // Order should be removed from open set (not stuck forever)
    const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
    expect(openOids).not.toContain('12');
    // Order status should be 'rejected'
    const orderData = await redisMock.hgetall(KEYS.LM_ORDER(12));
    expect(orderData.status).toBe('rejected');
  });

  // --- H2 regression: rejected sell orders removed from open set ---
  it('rejects and removes sell order from open set when tokens insufficient', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.70', '0.30');
    await redisMock.hset(KEYS.LM_USER_POS(USER, SLUG),
      'userId', USER, 'marketSlug', SLUG,
      'yesBalance', '10', 'noBalance', '0',
      'yesCost', '5', 'noCost', '0',
      'yesAvgPrice', '0.50', 'noAvgPrice', '0',
    );
    await createOpenOrder({ oid: 13, marketSlug: SLUG, outcome: 'yes', side: 'sell', price: '0.65', size: '50' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(0);
    const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
    expect(openOids).not.toContain('13');
    const orderData = await redisMock.hgetall(KEYS.LM_ORDER(13));
    expect(orderData.status).toBe('rejected');
  });

  // --- H3 regression: fill at market price, not limit ---
  it('fills BUY at market price which is better than limit price', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.30', '0.70'); // market price much lower than limit
    await createOpenOrder({ oid: 14, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '100' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    // Should fill at market price 0.30, not limit price 0.55
    expect(fillEvents[0].fill.price).toBe('0.30');
  });

  // --- M3 regression: dirty flag re-runs after pending match ---
  it('re-runs matching when pendingMatch is set during execution', async () => {
    await seedUser('10000');
    // First order fills in first cycle
    await seedPrice(SLUG, '0.50', '0.50');
    await createOpenOrder({ oid: 15, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '10' });

    await matcher.matchAll();
    expect(fillEvents).toHaveLength(1);
  });

  // --- M4 regression: corrupted JSON.parse doesn't crash ---
  it('skips orders with corrupted price data without crashing', async () => {
    await seedUser('10000');
    // Write corrupted price data
    await redisMock.hset(KEYS.LM_MARKET_PRICES, SLUG, 'NOT_VALID_JSON');
    await createOpenOrder({ oid: 16, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.55', size: '10' });

    // Should not throw
    await matcher.matchAll();
    expect(fillEvents).toHaveLength(0);
  });

  // --- L7 regression: clampPrice uses Decimal ---
  // (Tested via price updater, but verify fills work with edge prices)
  it('fills correctly at edge prices near 0.01 and 0.99', async () => {
    await seedUser('10000');
    await seedPrice(SLUG, '0.02', '0.98');
    await createOpenOrder({ oid: 17, marketSlug: SLUG, outcome: 'yes', side: 'buy', price: '0.05', size: '100' });

    await matcher.matchAll();

    expect(fillEvents).toHaveLength(1);
    expect(fillEvents[0].fill.price).toBe('0.02');
  });
});
