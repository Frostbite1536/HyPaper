import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    LOG_LEVEL: 'silent',
  },
}));

const { getLmPortfolio, getLmOpenOrders, getLmBalance } = await import('../engine/lm-position.js');

describe('getLmPortfolio', () => {
  const USER = '0xtest';

  beforeEach(() => {
    redisMock.flushall();
  });

  it('returns empty portfolio for new user', async () => {
    await redisMock.hset(KEYS.LM_USER_ACCOUNT(USER), 'balance', '10000');

    const portfolio = await getLmPortfolio(USER);

    expect(portfolio.balance).toBe('10000');
    expect(portfolio.positions).toHaveLength(0);
    expect(portfolio.totalUnrealizedPnl).toBe('0');
    expect(portfolio.accountValue).toBe('10000');
  });

  it('calculates unrealized PnL correctly for YES position', async () => {
    await redisMock.hset(KEYS.LM_USER_ACCOUNT(USER), 'balance', '9000');
    await redisMock.sadd(KEYS.LM_USER_POSITIONS(USER), 'test-market');
    await redisMock.hset(KEYS.LM_USER_POS(USER, 'test-market'),
      'userId', USER, 'marketSlug', 'test-market',
      'yesBalance', '100', 'noBalance', '0',
      'yesCost', '50', 'noCost', '0',
      'yesAvgPrice', '0.50', 'noAvgPrice', '0',
    );
    await redisMock.hset(KEYS.LM_MARKET_PRICES, 'test-market', JSON.stringify({ yes: '0.70', no: '0.30' }));
    await redisMock.hset(KEYS.LM_MARKETS, 'test-market', JSON.stringify({
      slug: 'test-market', title: 'Test Market', expirationDate: '2025-12-31',
    }));

    const portfolio = await getLmPortfolio(USER);

    expect(portfolio.positions).toHaveLength(1);
    const pos = portfolio.positions[0];
    // yesUnrealizedPnl = (0.70 - 0.50) * 100 = 20
    expect(pos.yesUnrealizedPnl).toBe('20');
    expect(pos.currentYesPrice).toBe('0.70');
    // totalMarketValue = 100 * 0.70 = 70
    expect(pos.totalMarketValue).toBe('70');
    // accountValue = balance + totalMarketValue = 9000 + 70 = 9070
    expect(portfolio.accountValue).toBe('9070');
  });

  it('calculates PnL for both YES and NO positions', async () => {
    await redisMock.hset(KEYS.LM_USER_ACCOUNT(USER), 'balance', '8000');
    await redisMock.sadd(KEYS.LM_USER_POSITIONS(USER), 'test-market');
    await redisMock.hset(KEYS.LM_USER_POS(USER, 'test-market'),
      'userId', USER, 'marketSlug', 'test-market',
      'yesBalance', '50', 'noBalance', '50',
      'yesCost', '25', 'noCost', '25',
      'yesAvgPrice', '0.50', 'noAvgPrice', '0.50',
    );
    await redisMock.hset(KEYS.LM_MARKET_PRICES, 'test-market', JSON.stringify({ yes: '0.60', no: '0.40' }));
    await redisMock.hset(KEYS.LM_MARKETS, 'test-market', JSON.stringify({
      slug: 'test-market', title: 'Test', expirationDate: '2025-12-31',
    }));

    const portfolio = await getLmPortfolio(USER);

    const pos = portfolio.positions[0];
    // yesUnrealizedPnl = (0.60 - 0.50) * 50 = 5
    expect(pos.yesUnrealizedPnl).toBe('5');
    // noUnrealizedPnl = (0.40 - 0.50) * 50 = -5
    expect(pos.noUnrealizedPnl).toBe('-5');
    // totalUnrealizedPnl = 5 + (-5) = 0
    expect(pos.totalUnrealizedPnl).toBe('0');
  });
});

describe('getLmOpenOrders', () => {
  const USER = '0xtest';

  beforeEach(() => {
    redisMock.flushall();
  });

  it('returns empty array when no orders', async () => {
    const orders = await getLmOpenOrders(USER);
    expect(orders).toHaveLength(0);
  });

  it('filters orders by userId and excludes other users', async () => {
    const OTHER = '0xother';
    // Open order for USER
    await redisMock.sadd(KEYS.LM_ORDERS_OPEN, '1');
    await redisMock.hset(KEYS.LM_ORDER(1),
      'oid', '1', 'userId', USER,
      'marketSlug', 'test-market', 'outcome', 'yes', 'side', 'buy',
      'price', '0.50', 'size', '10', 'orderType', 'limit',
      'status', 'open', 'filledSize', '0', 'avgFillPrice', '0',
      'createdAt', '1000', 'updatedAt', '1000',
    );
    // Open order for OTHER user
    await redisMock.sadd(KEYS.LM_ORDERS_OPEN, '2');
    await redisMock.hset(KEYS.LM_ORDER(2),
      'oid', '2', 'userId', OTHER,
      'marketSlug', 'test-market', 'outcome', 'no', 'side', 'sell',
      'price', '0.60', 'size', '20', 'orderType', 'limit',
      'status', 'open', 'filledSize', '0', 'avgFillPrice', '0',
      'createdAt', '2000', 'updatedAt', '2000',
    );

    const userOrders = await getLmOpenOrders(USER);
    expect(userOrders).toHaveLength(1);
    expect(userOrders[0].userId).toBe(USER);

    const otherOrders = await getLmOpenOrders(OTHER);
    expect(otherOrders).toHaveLength(1);
    expect(otherOrders[0].userId).toBe(OTHER);
  });

  it('returns only open orders', async () => {
    // Open order — must be in LM_ORDERS_OPEN set
    await redisMock.sadd(KEYS.LM_ORDERS_OPEN, '1');
    await redisMock.hset(KEYS.LM_ORDER(1),
      'oid', '1', 'userId', USER,
      'marketSlug', 'test-market', 'outcome', 'yes', 'side', 'buy',
      'price', '0.50', 'size', '10', 'orderType', 'limit',
      'status', 'open', 'filledSize', '0', 'avgFillPrice', '0',
      'createdAt', '1000', 'updatedAt', '1000',
    );
    // Filled order — NOT in LM_ORDERS_OPEN
    await redisMock.hset(KEYS.LM_ORDER(2),
      'oid', '2', 'userId', USER,
      'marketSlug', 'test-market', 'outcome', 'yes', 'side', 'buy',
      'price', '0.50', 'size', '10', 'orderType', 'limit',
      'status', 'filled', 'filledSize', '10', 'avgFillPrice', '0.50',
      'createdAt', '2000', 'updatedAt', '2000',
    );

    const orders = await getLmOpenOrders(USER);
    expect(orders).toHaveLength(1);
    expect(orders[0].oid).toBe(1);
    expect(orders[0].status).toBe('open');
  });
});

describe('getLmBalance', () => {
  const USER = '0xtest';

  beforeEach(() => {
    redisMock.flushall();
  });

  it('returns 0 for non-existent user', async () => {
    const balance = await getLmBalance(USER);
    expect(balance).toBe('0');
  });

  it('returns correct balance', async () => {
    await redisMock.hset(KEYS.LM_USER_ACCOUNT(USER), 'balance', '5000');
    const balance = await getLmBalance(USER);
    expect(balance).toBe('5000');
  });
});
