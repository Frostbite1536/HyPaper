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
    FEES_ENABLED: false,
    FEE_RATE_TAKER: '0',
    FEE_RATE_MAKER: '0',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60_000,
  },
}));

let oidCounter = 0;
let tidCounter = 100;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++oidCounter),
  nextTid: vi.fn(async () => ++tidCounter),
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(),
  updateUserBalance: vi.fn(),
}));

vi.mock('../store/pg-queries.js', () => ({
  getLmUserFillsPg: vi.fn(async () => []),
  getLmUserFillsByTimePg: vi.fn(async () => []),
}));

// Set up eventBus and matcher for lm-order.ts dependency
const eventBus = new EventEmitter();
const { LmOrderMatcher } = await import('../worker/lm-order-matcher.js');
const lmOrderMatcher = new LmOrderMatcher(eventBus);

vi.mock('../worker/index.js', () => ({
  eventBus,
  lmOrderMatcher,
}));

const { lmExchangeRouter } = await import('../api/routes/lm-exchange.js');
const { lmInfoRouter } = await import('../api/routes/lm-info.js');
const { lmHypaperRouter } = await import('../api/routes/lm-hypaper.js');

function post(router: any, body?: unknown) {
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return router.request('/', init);
}

function postRaw(router: any, rawBody: string) {
  return router.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

async function seedMarket(slug: string) {
  await redisMock.hset(KEYS.LM_MARKETS, slug, JSON.stringify({
    slug, title: 'Test', status: 'FUNDED', expirationDate: '2026-12-31',
    positionIds: [], winningOutcomeIndex: null, marketType: 'single-clob',
  }));
}

async function seedAccount(userId: string, balance = '10000') {
  await redisMock.hset(KEYS.LM_USER_ACCOUNT(userId),
    'userId', userId, 'balance', balance, 'createdAt', '0',
  );
}

// ===== /limitless/exchange =====

describe('/limitless/exchange validation', () => {
  beforeEach(() => {
    redisMock.flushall();
    oidCounter = 0;
    tidCounter = 100;
  });

  it('rejects malformed JSON', async () => {
    const res = await postRaw(lmExchangeRouter, 'bad');
    expect(res.status).toBe(400);
  });

  it('rejects missing wallet', async () => {
    const res = await post(lmExchangeRouter, { action: { type: 'order' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('wallet');
  });

  it('rejects missing action', async () => {
    const res = await post(lmExchangeRouter, { wallet: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(400);
  });

  it('rejects order with NaN price', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'buy', price: 'NaN', size: '10', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('finite');
  });

  it('rejects order with Infinity size', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'buy', price: '0.50', size: 'Infinity', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects order with negative price', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'buy', price: '-0.50', size: '10', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects order with non-numeric price string', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'buy', price: 'banana', size: '10', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('Invalid');
  });

  it('rejects order with zero size', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'buy', price: '0.50', size: '0', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid outcome', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'maybe',
        side: 'buy', price: '0.50', size: '10', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('outcome');
  });

  it('rejects invalid side', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'hold', price: '0.50', size: '10', orderType: 'limit',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('side');
  });

  it('rejects invalid orderType', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test', outcome: 'yes',
        side: 'buy', price: '0.50', size: '10', orderType: 'stop',
      },
    });
    expect(res.status).toBe(400);
  });

  it('accepts valid limit order for existing market', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    await seedMarket('test-market');
    await redisMock.hset(KEYS.LM_MARKET_PRICES, 'test-market', JSON.stringify({ yes: '0.70', no: '0.30' }));

    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order', marketSlug: 'test-market', outcome: 'yes',
        side: 'buy', price: '0.50', size: '10', orderType: 'limit',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('rejects cancel with missing orderId', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'cancel' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects cancelAll with missing marketSlug', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'cancelAll' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects unsupported action type', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmExchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'nonexistent' },
    });
    expect(res.status).toBe(400);
  });
});

// ===== /limitless/info =====

describe('/limitless/info validation', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('rejects malformed JSON', async () => {
    const res = await postRaw(lmInfoRouter, '!!');
    expect(res.status).toBe(400);
  });

  it('rejects missing type', async () => {
    const res = await post(lmInfoRouter, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('type');
  });

  it('rejects portfolio without user', async () => {
    const res = await post(lmInfoRouter, { type: 'portfolio' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('user');
  });

  it('rejects openOrders without user', async () => {
    const res = await post(lmInfoRouter, { type: 'openOrders' });
    expect(res.status).toBe(400);
  });

  it('rejects userFills without user', async () => {
    const res = await post(lmInfoRouter, { type: 'userFills' });
    expect(res.status).toBe(400);
  });

  it('returns markets list', async () => {
    await seedMarket('test-market');
    const res = await post(lmInfoRouter, { type: 'markets' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].slug).toBe('test-market');
  });

  it('returns single market', async () => {
    await seedMarket('test-market');
    const res = await post(lmInfoRouter, { type: 'market', slug: 'test-market' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe('test-market');
  });

  it('returns 404 for missing market', async () => {
    const res = await post(lmInfoRouter, { type: 'market', slug: 'nonexistent' });
    expect(res.status).toBe(404);
  });

  it('rejects market without slug', async () => {
    const res = await post(lmInfoRouter, { type: 'market' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('slug');
  });

  it('returns empty orderbook for unknown slug', async () => {
    const res = await post(lmInfoRouter, { type: 'orderbook', slug: 'nonexistent' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bids).toEqual([]);
  });

  it('returns balance for user', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001', '5000');
    const res = await post(lmInfoRouter, { type: 'balance', user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe('5000');
  });

  it('rejects unknown type', async () => {
    const res = await post(lmInfoRouter, { type: 'nonexistent' });
    expect(res.status).toBe(400);
  });
});

// ===== /limitless/hypaper =====

describe('/limitless/hypaper validation', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('rejects malformed JSON', async () => {
    const res = await postRaw(lmHypaperRouter, '');
    expect(res.status).toBe(400);
  });

  it('rejects missing type', async () => {
    const res = await post(lmHypaperRouter, { user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(400);
  });

  it('rejects missing user', async () => {
    const res = await post(lmHypaperRouter, { type: 'resetAccount' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('user');
  });

  it('rejects setBalance with NaN', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: NaN });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('finite');
  });

  it('rejects setBalance with Infinity', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: Infinity });
    expect(res.status).toBe(400);
  });

  it('rejects setBalance with negative value', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: -100 });
    expect(res.status).toBe(400);
  });

  it('rejects setBalance over 1 billion', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: 2_000_000_000 });
    expect(res.status).toBe(400);
  });

  it('accepts valid setBalance', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: 5000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe('5000');
  });

  it('returns account info', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'getAccountInfo', user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('0x0000000000000000000000000000000000000001');
  });

  it('resets account', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'resetAccount', user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain('reset');
  });

  it('rejects unknown type', async () => {
    await seedAccount('0x0000000000000000000000000000000000000001');
    const res = await post(lmHypaperRouter, { type: 'nonexistent', user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(400);
  });
});
