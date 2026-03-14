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
    LOG_LEVEL: 'silent',
  },
}));

let oidCounter = 0;
let tidCounter = 100;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++oidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));

// Mock pg-sink to avoid DB calls
vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(),
  updateUserBalance: vi.fn(),
}));

// Mock the eventBus and shared matcher
const eventBus = new EventEmitter();
const { LmOrderMatcher } = await import('../worker/lm-order-matcher.js');
const lmOrderMatcher = new LmOrderMatcher(eventBus);
vi.mock('../worker/index.js', () => ({
  eventBus,
  lmOrderMatcher,
}));

const { placeLmOrder, cancelLmOrder, ensureLmAccount } = await import('../engine/lm-order.js');

describe('placeLmOrder', () => {
  beforeEach(() => {
    redisMock.flushall();
    oidCounter = 0;
    tidCounter = 100;
  });

  async function seedMarket(slug: string, status = 'FUNDED') {
    await redisMock.hset(KEYS.LM_MARKETS, slug, JSON.stringify({
      slug, title: 'Test', status, expirationDate: '2025-12-31',
      positionIds: [], winningOutcomeIndex: null, marketType: 'single-clob',
    }));
  }

  async function seedAccount(userId: string, balance: string) {
    await redisMock.hset(KEYS.LM_USER_ACCOUNT(userId),
      'userId', userId, 'balance', balance, 'createdAt', '0',
    );
  }

  it('rejects order for non-existent market', async () => {
    await seedAccount('0xuser', '10000');
    const result = await placeLmOrder('0xuser', 'nonexistent', 'yes', 'buy', '0.50', '10', 'limit');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('not found');
    }
  });

  it('rejects order with price < 0.01', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '0.005', '10', 'limit');
    expect(result.status).toBe('error');
  });

  it('rejects order with price > 0.99', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '1.50', '10', 'limit');
    expect(result.status).toBe('error');
  });

  it('rejects BUY order when insufficient balance', async () => {
    await seedAccount('0xuser', '1'); // Only $1
    await seedMarket('test-market');
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '0.50', '100', 'limit');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('Insufficient balance');
    }
  });

  it('rejects SELL order when insufficient tokens', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    // No position exists
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'sell', '0.50', '100', 'limit');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('Insufficient tokens');
    }
  });

  it('limit order rests if price does not cross', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    await redisMock.hset(KEYS.LM_MARKET_PRICES, 'test-market', JSON.stringify({ yes: '0.60', no: '0.40' }));

    // BUY YES at 0.55, but yesPrice = 0.60 > 0.55 → rests
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '0.55', '10', 'limit');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // Verify order is in open set
      const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
      expect(openOids).toContain(result.oid.toString());
    }
  });

  it('limit order fills immediately if price crosses', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    await redisMock.hset(KEYS.LM_MARKET_PRICES, 'test-market', JSON.stringify({ yes: '0.50', no: '0.50' }));

    // BUY YES at 0.55, yesPrice = 0.50 <= 0.55 → fills
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '0.55', '10', 'limit');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // Verify order is NOT in open set (was filled)
      const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
      expect(openOids).not.toContain(result.oid.toString());
    }
  });

  it('market order rejected if no price available', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    // No prices seeded

    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '0.50', '10', 'market');
    expect(result.status).toBe('error');
  });

  it('creates order with correct fields', async () => {
    await seedAccount('0xuser', '10000');
    await seedMarket('test-market');
    await redisMock.hset(KEYS.LM_MARKET_PRICES, 'test-market', JSON.stringify({ yes: '0.70', no: '0.30' }));

    // BUY at 0.55, yesPrice = 0.70 > 0.55 → rests
    const result = await placeLmOrder('0xuser', 'test-market', 'yes', 'buy', '0.55', '10', 'limit');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const orderData = await redisMock.hgetall(KEYS.LM_ORDER(result.oid));
      expect(orderData.userId).toBe('0xuser');
      expect(orderData.marketSlug).toBe('test-market');
      expect(orderData.outcome).toBe('yes');
      expect(orderData.side).toBe('buy');
      expect(orderData.price).toBe('0.55');
      expect(orderData.size).toBe('10');
      expect(orderData.status).toBe('open');
    }
  });
});

describe('cancelLmOrder', () => {
  beforeEach(() => {
    redisMock.flushall();
    oidCounter = 0;
    tidCounter = 100;
  });

  async function seedOpenOrder(userId: string, oid: number) {
    await redisMock.hset(KEYS.LM_ORDER(oid),
      'oid', oid.toString(), 'userId', userId,
      'marketSlug', 'test-market', 'outcome', 'yes', 'side', 'buy',
      'price', '0.50', 'size', '10', 'orderType', 'limit',
      'status', 'open', 'filledSize', '0', 'avgFillPrice', '0',
      'createdAt', '1000', 'updatedAt', '1000',
    );
    await redisMock.sadd(KEYS.LM_ORDERS_OPEN, oid.toString());
  }

  it('cancels open order', async () => {
    await seedOpenOrder('0xuser', 1);
    const result = await cancelLmOrder('0xuser', 1);
    expect(result.status).toBe('ok');

    const orderData = await redisMock.hgetall(KEYS.LM_ORDER(1));
    expect(orderData.status).toBe('cancelled');
  });

  it('rejects cancel for non-existent order', async () => {
    const result = await cancelLmOrder('0xuser', 999);
    expect(result.status).toBe('error');
  });

  it('rejects cancel for order owned by different user', async () => {
    await seedOpenOrder('0xother', 1);
    const result = await cancelLmOrder('0xuser', 1);
    expect(result.status).toBe('error');
  });

  it('rejects cancel for already filled order', async () => {
    await redisMock.hset(KEYS.LM_ORDER(1),
      'oid', '1', 'userId', '0xuser',
      'marketSlug', 'test-market', 'status', 'filled',
      'outcome', 'yes', 'side', 'buy', 'price', '0.50', 'size', '10',
      'orderType', 'limit', 'filledSize', '10', 'avgFillPrice', '0.50',
      'createdAt', '1000', 'updatedAt', '2000',
    );
    const result = await cancelLmOrder('0xuser', 1);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('not open');
    }
  });

  it('removes cancelled order from open set', async () => {
    await seedOpenOrder('0xuser', 1);
    await cancelLmOrder('0xuser', 1);

    const openOids = await redisMock.smembers(KEYS.LM_ORDERS_OPEN);
    expect(openOids).not.toContain('1');
  });
});
