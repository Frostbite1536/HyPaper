import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, div, abs, gt, lt, isZero, neg } from '../utils/math.js';

export async function calculateAccountValue(userId: string): Promise<string> {
  const balance = await getBalance(userId);
  const unrealizedPnl = await calculateTotalUnrealizedPnl(userId);
  return add(balance, unrealizedPnl);
}

export async function getBalance(userId: string): Promise<string> {
  const balance = await redis.hget(KEYS.USER_ACCOUNT(userId), 'balance');
  return balance ?? '0';
}

export async function calculateTotalUnrealizedPnl(userId: string): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
  if (positionAssets.length === 0) return '0';

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  let totalPnl = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const midPx = mids[pos.coin];
    if (!midPx) continue;

    const pnl = calculatePositionUnrealizedPnl(pos.szi, pos.entryPx, midPx);
    totalPnl = add(totalPnl, pnl);
  }

  return totalPnl;
}

export function calculatePositionUnrealizedPnl(szi: string, entryPx: string, markPx: string): string {
  if (isZero(szi)) return '0';
  const isLong = gt(szi, '0');
  const size = abs(szi);
  if (isLong) {
    return mul(sub(markPx, entryPx), size);
  } else {
    return mul(sub(entryPx, markPx), size);
  }
}

export async function calculateTotalMarginUsed(userId: string): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
  if (positionAssets.length === 0) return '0';

  const mids = await redis.hgetall(KEYS.MARKET_MIDS);
  let totalMargin = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const midPx = mids[pos.coin];
    if (!midPx) continue;

    const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
    const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;

    const posValue = mul(abs(pos.szi), midPx);
    const margin = div(posValue, leverage.toString());
    totalMargin = add(totalMargin, margin);
  }

  return totalMargin;
}

export async function calculatePositionMarginUsed(
  userId: string,
  asset: number,
  szi: string,
  markPx: string,
): Promise<string> {
  if (isZero(szi)) return '0';
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
  const posValue = mul(abs(szi), markPx);
  return div(posValue, leverage.toString());
}

export async function checkMarginForOrder(
  userId: string,
  asset: number,
  isBuy: boolean,
  sz: string,
  px: string,
): Promise<boolean> {
  const accountValue = await calculateAccountValue(userId);
  const currentMarginUsed = await calculateTotalMarginUsed(userId);
  const available = sub(accountValue, currentMarginUsed);

  // Calculate margin needed for this order
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;

  // Check if this is reducing an existing position
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  const currentSzi = pos.szi ?? '0';

  if (!isZero(currentSzi)) {
    const isLong = gt(currentSzi, '0');
    const isReducing = (isLong && !isBuy) || (!isLong && isBuy);

    if (isReducing) {
      // Reducing a position doesn't require additional margin
      return true;
    }
  }

  const orderNotional = mul(sz, px);
  const marginNeeded = div(orderNotional, leverage.toString());

  return !lt(available, marginNeeded);
}

export function calculateLiquidationPrice(
  szi: string,
  entryPx: string,
  accountValue: string,
  leverage: number,
): string | null {
  if (isZero(szi)) return null;

  const isLong = gt(szi, '0');
  const size = abs(szi);
  const margin = div(mul(size, entryPx), leverage.toString());

  // Maintenance margin is ~half of initial margin
  const maintMarginRate = div('1', (leverage * 2).toString());

  if (isLong) {
    // liqPx = entryPx * (1 - 1/leverage + maintMarginRate)
    // Simplified: price drops enough to eat through margin
    const liqPx = mul(entryPx, sub('1', sub(div('1', leverage.toString()), maintMarginRate)));
    return gt(liqPx, '0') ? liqPx : '0';
  } else {
    const liqPx = mul(entryPx, add('1', sub(div('1', leverage.toString()), maintMarginRate)));
    return liqPx;
  }
}
