import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D, lte, gte, isZero, lt, mul } from '../utils/math.js';
import { nextOid } from '../utils/id.js';
import { eventBus, lmOrderMatcher as matcher } from '../worker/index.js';
import { upsertUser } from '../store/pg-sink.js';
import type { LmPaperOrder } from '../types/limitless-order.js';
import type { LmCachedMarket } from '../types/limitless.js';

function isValidCachedMarket(v: unknown): v is LmCachedMarket {
  return typeof v === 'object' && v !== null
    && typeof (v as LmCachedMarket).slug === 'string'
    && typeof (v as LmCachedMarket).status === 'string';
}

export async function ensureLmAccount(userId: string): Promise<void> {
  const exists = await redis.exists(KEYS.LM_USER_ACCOUNT(userId));
  if (exists) return;

  // Use HSETNX on a sentinel field to atomically claim creation.
  // If another concurrent request already created the account, this returns 0.
  const created = await redis.hsetnx(KEYS.LM_USER_ACCOUNT(userId), 'userId', userId);
  if (!created) return;

  await redis.hset(KEYS.LM_USER_ACCOUNT(userId),
    'balance', config.LM_DEFAULT_BALANCE.toString(),
    'createdAt', Date.now().toString(),
  );
  upsertUser(userId, config.LM_DEFAULT_BALANCE.toString());
}

export async function placeLmOrder(
  userId: string,
  marketSlug: string,
  outcome: 'yes' | 'no',
  side: 'buy' | 'sell',
  price: string,
  size: string,
  orderType: 'limit' | 'market',
): Promise<{ status: 'ok'; oid: number } | { status: 'error'; message: string }> {
  // 1. VALIDATE MARKET EXISTS
  const marketRaw = await redis.hget(KEYS.LM_MARKETS, marketSlug);
  if (!marketRaw) {
    return { status: 'error', message: `Market not found: ${marketSlug}` };
  }
  const market: unknown = JSON.parse(marketRaw);
  if (!isValidCachedMarket(market)) {
    return { status: 'error', message: `Corrupted market data for: ${marketSlug}` };
  }
  if (market.status !== 'FUNDED') {
    return { status: 'error', message: `Market is not active (status: ${market.status})` };
  }

  // 2. VALIDATE PRICE (INV-DATA-002) — use Decimal, not Number()
  let pxDecimal;
  try {
    pxDecimal = D(price);
  } catch {
    return { status: 'error', message: 'Price must be between 0.01 and 0.99' };
  }
  if (!pxDecimal.isFinite() || pxDecimal.lessThan('0.01') || pxDecimal.greaterThan('0.99')) {
    return { status: 'error', message: 'Price must be between 0.01 and 0.99' };
  }

  // Validate size > 0 — use Decimal, not Number()
  let szDecimal;
  try {
    szDecimal = D(size);
  } catch {
    return { status: 'error', message: 'Size must be a finite positive number' };
  }
  if (!szDecimal.isFinite() || szDecimal.lessThanOrEqualTo('0')) {
    return { status: 'error', message: 'Size must be a finite positive number' };
  }

  // 3. VALIDATE BALANCE (INV-DATA-003)
  if (side === 'buy') {
    const cost = mul(price, size);
    const balance = await redis.hget(KEYS.LM_USER_ACCOUNT(userId), 'balance');
    if (!balance || lt(balance, cost)) {
      return { status: 'error', message: 'Insufficient balance' };
    }
  } else {
    // sell: need tokens
    const posData = await redis.hgetall(KEYS.LM_USER_POS(userId, marketSlug));
    const tokenBalance = outcome === 'yes' ? (posData.yesBalance ?? '0') : (posData.noBalance ?? '0');
    if (lt(tokenBalance, size)) {
      return { status: 'error', message: 'Insufficient tokens' };
    }
  }

  // 4. CREATE ORDER
  const oid = await nextOid();
  const now = Date.now();
  const order: LmPaperOrder = {
    oid,
    userId,
    marketSlug,
    outcome,
    side,
    price,
    size,
    orderType,
    status: 'open',
    filledSize: '0',
    avgFillPrice: '0',
    createdAt: now,
    updatedAt: now,
  };

  // Save order to Redis
  await redis.hset(KEYS.LM_ORDER(oid),
    'oid', oid.toString(),
    'userId', userId,
    'marketSlug', marketSlug,
    'outcome', outcome,
    'side', side,
    'price', price,
    'size', size,
    'orderType', orderType,
    'status', 'open',
    'filledSize', '0',
    'avgFillPrice', '0',
    'createdAt', now.toString(),
    'updatedAt', now.toString(),
  );
  await redis.zadd(KEYS.LM_USER_ORDERS(userId), now, oid.toString());

  // 5. ATTEMPT IMMEDIATE FILL
  const pricesRaw = await redis.hget(KEYS.LM_MARKET_PRICES, marketSlug);

  if (orderType === 'market') {
    if (!pricesRaw) {
      // No price available - reject market order
      await redis.hset(KEYS.LM_ORDER(oid), 'status', 'rejected', 'updatedAt', Date.now().toString());
      order.status = 'rejected';
      eventBus.emit('lm:orderUpdate', { userId, order, status: 'rejected' });
      return { status: 'error', message: 'Market order could not be filled: no price available' };
    }

    const prices = JSON.parse(pricesRaw) as { yes: string; no: string };
    const currentPrice = outcome === 'yes' ? prices.yes : prices.no;
    const filled = await matcher.executeFill(order, currentPrice);
    if (!filled) {
      return { status: 'error', message: 'Market order could not be filled: insufficient balance' };
    }
    return { status: 'ok', oid };
  }

  // LIMIT order
  if (pricesRaw) {
    const prices = JSON.parse(pricesRaw) as { yes: string; no: string };
    const currentPrice = outcome === 'yes' ? prices.yes : prices.no;

    const shouldFill = side === 'buy'
      ? lte(currentPrice, price)
      : gte(currentPrice, price);

    if (shouldFill) {
      // Fill at market price (guaranteed at-or-better than limit)
      await matcher.executeFill(order, currentPrice);
      return { status: 'ok', oid };
    }
  }

  // Rest the limit order
  await redis.sadd(KEYS.LM_ORDERS_OPEN, oid.toString());
  eventBus.emit('lm:orderUpdate', { userId, order, status: 'open' });

  return { status: 'ok', oid };
}

export async function cancelLmOrder(
  userId: string,
  oid: number,
): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
  const orderData = await redis.hgetall(KEYS.LM_ORDER(oid));
  if (!orderData.oid) {
    return { status: 'error', message: `Order ${oid} not found` };
  }
  if (orderData.userId !== userId) {
    return { status: 'error', message: `Order ${oid} not found` };
  }
  if (orderData.status !== 'open') {
    return { status: 'error', message: `Order ${oid} is not open (status: ${orderData.status})` };
  }

  const now = Date.now();
  const pipeline = redis.pipeline();
  pipeline.hset(KEYS.LM_ORDER(oid), 'status', 'cancelled', 'updatedAt', now.toString());
  pipeline.srem(KEYS.LM_ORDERS_OPEN, oid.toString());
  await pipeline.exec();

  const order: LmPaperOrder = {
    oid,
    userId,
    marketSlug: orderData.marketSlug,
    outcome: orderData.outcome as 'yes' | 'no',
    side: orderData.side as 'buy' | 'sell',
    price: orderData.price,
    size: orderData.size,
    orderType: orderData.orderType as 'limit' | 'market',
    status: 'cancelled',
    filledSize: orderData.filledSize ?? '0',
    avgFillPrice: orderData.avgFillPrice ?? '0',
    createdAt: parseInt(orderData.createdAt, 10),
    updatedAt: now,
  };

  eventBus.emit('lm:orderUpdate', { userId, order, status: 'cancelled' });

  return { status: 'ok' };
}

export async function cancelAllLmOrders(
  userId: string,
  marketSlug: string,
): Promise<{ cancelled: number }> {
  const openOids = await redis.smembers(KEYS.LM_ORDERS_OPEN);
  if (openOids.length === 0) return { cancelled: 0 };

  // Pipeline all reads to avoid N+1
  const pipeline = redis.pipeline();
  for (const oidStr of openOids) {
    pipeline.hgetall(KEYS.LM_ORDER(parseInt(oidStr, 10)));
  }
  const results = await pipeline.exec();

  let cancelled = 0;
  for (let i = 0; i < openOids.length; i++) {
    const [err, orderData] = results![i] as [Error | null, Record<string, string>];
    if (err || !orderData) continue;
    if (orderData.userId !== userId || orderData.marketSlug !== marketSlug || orderData.status !== 'open') continue;

    const oid = parseInt(openOids[i], 10);
    const result = await cancelLmOrder(userId, oid);
    if (result.status === 'ok') cancelled++;
  }

  return { cancelled };
}
