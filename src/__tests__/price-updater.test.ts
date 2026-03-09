import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

const { PriceUpdater } = await import('../worker/price-updater.js');

describe('PriceUpdater', () => {
  let eventBus: EventEmitter;
  let onUpdate: ReturnType<typeof vi.fn>;
  let priceUpdater: InstanceType<typeof PriceUpdater>;

  beforeEach(() => {
    redisMock.flushall();
    eventBus = new EventEmitter();
    onUpdate = vi.fn();
    priceUpdater = new PriceUpdater(onUpdate, eventBus);
  });

  it('uses activeAssetCtx.midPx to refresh market mids', async () => {
    const midsEvents: Array<Record<string, string>> = [];
    eventBus.on('mids', (event) => midsEvents.push(event.mids));

    await priceUpdater.handleMessage('activeAssetCtx', {
      coin: 'BTC',
      ctx: {
        markPx: '68091.5',
        midPx: '67456.5',
        oraclePx: '67000',
        funding: '0.0001',
        openInterest: '1',
        prevDayPx: '66000',
        dayNtlVlm: '100',
        premium: '0.01',
      },
    });

    expect(await redisMock.hget(KEYS.MARKET_MIDS, 'BTC')).toBe('67456.5');
    expect(await redisMock.hget(KEYS.MARKET_CTX('BTC'), 'midPx')).toBe('67456.5');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(midsEvents).toEqual([{ BTC: '67456.5' }]);
  });

  it('falls back to markPx when activeAssetCtx.midPx is absent', async () => {
    await priceUpdater.handleMessage('activeAssetCtx', {
      coin: 'ETH',
      ctx: {
        markPx: '2002.65',
        oraclePx: '1980',
        funding: '0.0001',
        openInterest: '1',
        prevDayPx: '1900',
        dayNtlVlm: '100',
        premium: '0.01',
      },
    });

    expect(await redisMock.hget(KEYS.MARKET_MIDS, 'ETH')).toBe('2002.65');
    expect(await redisMock.hget(KEYS.MARKET_CTX('ETH'), 'midPx')).toBe('');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
