import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

const mockConfig = {
  FUNDING_ENABLED: true,
  FUNDING_INTERVAL_MS: 28_800_000,
  FEES_ENABLED: false,
  FEE_RATE_TAKER: '0.00035',
  FEE_RATE_MAKER: '0.0001',
  LOG_LEVEL: 'silent',
};

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const { FundingWorker } = await import('../worker/funding-worker.js');

describe('FundingWorker', () => {
  let worker: InstanceType<typeof FundingWorker>;

  const USER = '0xfundtest';
  const COIN = 'BTC';
  const ASSET = 0;

  beforeEach(() => {
    redisMock.flushall();
    mockConfig.FUNDING_ENABLED = true;
    worker = new FundingWorker();
  });

  async function seedUser(balance: string) {
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', balance);
  }

  async function setPosition(szi: string, entryPx: string) {
    await redisMock.hset(
      KEYS.USER_POS(USER, ASSET),
      'userId', USER,
      'asset', ASSET.toString(),
      'coin', COIN,
      'szi', szi,
      'entryPx', entryPx,
      'cumFunding', '0',
      'cumFundingSinceOpen', '0',
      'cumFundingSinceChange', '0',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), ASSET.toString());
    await redisMock.sadd(KEYS.USERS_ACTIVE, USER);
  }

  async function setMarketCtx(coin: string, markPx: string, funding: string) {
    await redisMock.hset(KEYS.MARKET_CTX(coin),
      'markPx', markPx,
      'funding', funding,
    );
  }

  it('deducts funding from long position when rate is positive', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    // fundingCharge = 1 * 50000 * 0.0001 = 5
    // balance = 100000 - 5 = 99995
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(99995, 2);

    const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
    expect(pos.cumFunding).toBe('5');
    expect(pos.cumFundingSinceOpen).toBe('5');
    expect(pos.cumFundingSinceChange).toBe('5');
  });

  it('credits funding to short position when rate is positive', async () => {
    await seedUser('100000');
    await setPosition('-1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    // fundingCharge = -1 * 50000 * 0.0001 = -5
    // balance = 100000 - (-5) = 100005 (short receives funding)
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(100005, 2);

    const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
    expect(pos.cumFunding).toBe('-5');
  });

  it('updates all cumFunding fields correctly', async () => {
    await seedUser('100000');
    // Start with some existing cumFunding
    await redisMock.hset(
      KEYS.USER_POS(USER, ASSET),
      'userId', USER, 'asset', '0', 'coin', COIN,
      'szi', '2', 'entryPx', '50000',
      'cumFunding', '10',
      'cumFundingSinceOpen', '10',
      'cumFundingSinceChange', '5',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), '0');
    await redisMock.sadd(KEYS.USERS_ACTIVE, USER);
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    // fundingCharge = 2 * 50000 * 0.0001 = 10
    const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
    expect(pos.cumFunding).toBe('20');
    expect(pos.cumFundingSinceOpen).toBe('20');
    expect(pos.cumFundingSinceChange).toBe('15');
  });

  it('does nothing when FUNDING_ENABLED is false', async () => {
    mockConfig.FUNDING_ENABLED = false;
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('skips when funding rate is zero', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0');

    await worker.applyFunding();

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('skips when funding rate is missing', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    // Set market ctx without funding
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '50000');

    await worker.applyFunding();

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('removes user from USERS_ACTIVE when no positions', async () => {
    await seedUser('100000');
    // Add user as active but with no positions
    await redisMock.sadd(KEYS.USERS_ACTIVE, USER);

    await worker.applyFunding();

    const activeUsers = await redisMock.smembers(KEYS.USERS_ACTIVE);
    expect(activeUsers).not.toContain(USER);
  });
});
