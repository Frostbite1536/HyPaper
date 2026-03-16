import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../config.js', () => ({
  config: {
    HL_API_URL: 'https://api.hyperliquid.xyz',
    DEFAULT_BALANCE: 100_000,
    LM_ENABLED: false,
    FEES_ENABLED: false,
    FEE_RATE_TAKER: '0.00035',
    FEE_RATE_MAKER: '0.0001',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW_MS: 60_000,
  },
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(),
  updateUserBalance: vi.fn(),
}));

vi.mock('../store/pg-queries.js', () => ({
  getUserFillsPg: vi.fn(async () => []),
  getUserFillsByTimePg: vi.fn(async () => []),
}));

// Mock the engine modules to isolate route validation
const mockPlaceOrders = vi.fn(async () => [{ resting: { oid: 1 } }]);
const mockCancelOrders = vi.fn(async () => ['success']);
const mockCancelByCloid = vi.fn(async () => ['success']);
const mockUpdateLeverage = vi.fn(async () => undefined);

vi.mock('../engine/order.js', () => ({
  placeOrders: mockPlaceOrders,
  cancelOrders: mockCancelOrders,
  cancelByCloid: mockCancelByCloid,
  updateLeverage: mockUpdateLeverage,
}));

vi.mock('../engine/position.js', () => ({
  getClearinghouseState: vi.fn(async () => ({ assetPositions: [], crossMaintenanceMarginUsed: '0' })),
  getOpenOrders: vi.fn(async () => []),
  getFrontendOpenOrders: vi.fn(async () => []),
  getOrderStatus: vi.fn(async (oid: number) => ({ status: 'unknownOid' })),
}));

vi.mock('../engine/fill.js', () => ({
  getUserFills: vi.fn(async () => []),
  getUserFillsByTime: vi.fn(async () => []),
}));

vi.mock('../api/middleware/auth.js', () => ({
  ensureAccount: vi.fn(async () => undefined),
}));

const { exchangeRouter } = await import('../api/routes/exchange.js');
const { infoRouter } = await import('../api/routes/info.js');
const { hypaperRouter } = await import('../api/routes/hypaper.js');

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

// ===== /exchange =====

describe('/exchange validation', () => {
  beforeEach(() => {
    redisMock.flushall();
    mockPlaceOrders.mockClear();
  });

  it('rejects malformed JSON', async () => {
    const res = await postRaw(exchangeRouter, '{not json');
    expect(res.status).toBe(400);
  });

  it('rejects missing wallet', async () => {
    const res = await post(exchangeRouter, { action: { type: 'order' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('wallet');
  });

  it('rejects missing action', async () => {
    const res = await post(exchangeRouter, { wallet: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('action');
  });

  it('rejects NaN in order price', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order',
        orders: [{
          a: 0, b: true, p: 'NaN', s: '1', r: false,
          t: { limit: { tif: 'Gtc' } },
        }],
        grouping: 'na',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('finite');
  });

  it('rejects Infinity in order size', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order',
        orders: [{
          a: 0, b: true, p: '100', s: 'Infinity', r: false,
          t: { limit: { tif: 'Gtc' } },
        }],
        grouping: 'na',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects negative size', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order',
        orders: [{
          a: 0, b: true, p: '100', s: '-5', r: false,
          t: { limit: { tif: 'Gtc' } },
        }],
        grouping: 'na',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects zero price', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order',
        orders: [{
          a: 0, b: true, p: '0', s: '1', r: false,
          t: { limit: { tif: 'Gtc' } },
        }],
        grouping: 'na',
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects more than 50 orders', async () => {
    const orders = Array.from({ length: 51 }, () => ({
      a: 0, b: true, p: '100', s: '1', r: false,
      t: { limit: { tif: 'Gtc' } },
    }));
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'order', orders, grouping: 'na' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('50');
  });

  it('accepts valid order and calls placeOrders', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: {
        type: 'order',
        orders: [{
          a: 0, b: true, p: '100', s: '1', r: false,
          t: { limit: { tif: 'Gtc' } },
        }],
        grouping: 'na',
      },
    });
    expect(res.status).toBe(200);
    expect(mockPlaceOrders).toHaveBeenCalledOnce();
  });

  it('rejects cancel with missing cancels array', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'cancel' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects cancel with invalid format', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'cancel', cancels: [{ a: 'not-a-number', o: 1 }] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects unsupported action type', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'nonexistent' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('Unsupported');
  });

  it('rejects updateLeverage with out-of-range leverage', async () => {
    const res = await post(exchangeRouter, {
      wallet: '0x0000000000000000000000000000000000000001',
      action: { type: 'updateLeverage', asset: 0, leverage: 500, isCross: true },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.response).toContain('1 and 200');
  });
});

// ===== /info =====

describe('/info validation', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('rejects malformed JSON', async () => {
    const res = await postRaw(infoRouter, 'not-json');
    expect(res.status).toBe(400);
  });

  it('rejects missing type', async () => {
    const res = await post(infoRouter, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('type');
  });

  it('rejects clearinghouseState without user', async () => {
    const res = await post(infoRouter, { type: 'clearinghouseState' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('user');
  });

  it('rejects orderStatus with non-numeric oid', async () => {
    const res = await post(infoRouter, { type: 'orderStatus', oid: 'abc' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('oid');
  });

  it('rejects orderStatus with NaN oid', async () => {
    const res = await post(infoRouter, { type: 'orderStatus', oid: NaN });
    expect(res.status).toBe(400);
  });

  it('rejects orderStatus with negative oid', async () => {
    const res = await post(infoRouter, { type: 'orderStatus', oid: -5 });
    expect(res.status).toBe(400);
  });

  it('returns allMids from redis', async () => {
    await redisMock.hset(KEYS.MARKET_MIDS, 'BTC', '50000');
    const res = await post(infoRouter, { type: 'allMids' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.BTC).toBe('50000');
  });

  it('rejects openOrders without user', async () => {
    const res = await post(infoRouter, { type: 'openOrders' });
    expect(res.status).toBe(400);
  });

  it('rejects userFills without user', async () => {
    const res = await post(infoRouter, { type: 'userFills' });
    expect(res.status).toBe(400);
  });
});

// ===== /hypaper =====

describe('/hypaper validation', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('rejects malformed JSON', async () => {
    const res = await postRaw(hypaperRouter, '{{invalid');
    expect(res.status).toBe(400);
  });

  it('rejects missing type', async () => {
    const res = await post(hypaperRouter, { user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('type');
  });

  it('rejects missing user', async () => {
    const res = await post(hypaperRouter, { type: 'resetAccount' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('user');
  });

  it('rejects setBalance with NaN', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT('0x0000000000000000000000000000000000000001'), 'userId', '0x0000000000000000000000000000000000000001', 'balance', '100000', 'createdAt', '0');
    const res = await post(hypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: NaN });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('finite');
  });

  it('rejects setBalance with Infinity', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT('0x0000000000000000000000000000000000000001'), 'userId', '0x0000000000000000000000000000000000000001', 'balance', '100000', 'createdAt', '0');
    const res = await post(hypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: Infinity });
    expect(res.status).toBe(400);
  });

  it('rejects setBalance with negative', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT('0x0000000000000000000000000000000000000001'), 'userId', '0x0000000000000000000000000000000000000001', 'balance', '100000', 'createdAt', '0');
    const res = await post(hypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: -100 });
    expect(res.status).toBe(400);
  });

  it('accepts valid setBalance', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT('0x0000000000000000000000000000000000000001'), 'userId', '0x0000000000000000000000000000000000000001', 'balance', '100000', 'createdAt', '0');
    const res = await post(hypaperRouter, { type: 'setBalance', user: '0x0000000000000000000000000000000000000001', balance: 50000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe('50000');
  });

  it('returns account info', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT('0x0000000000000000000000000000000000000001'),
      'userId', '0x0000000000000000000000000000000000000001', 'balance', '100000', 'createdAt', '1700000000000',
    );
    const res = await post(hypaperRouter, { type: 'getAccountInfo', user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('0x0000000000000000000000000000000000000001');
    expect(body.balance).toBe('100000');
  });

  it('rejects unknown type', async () => {
    await redisMock.hset(KEYS.USER_ACCOUNT('0x0000000000000000000000000000000000000001'), 'userId', '0x0000000000000000000000000000000000000001', 'balance', '100000', 'createdAt', '0');
    const res = await post(hypaperRouter, { type: 'nonexistent', user: '0x0000000000000000000000000000000000000001' });
    expect(res.status).toBe(400);
  });
});
