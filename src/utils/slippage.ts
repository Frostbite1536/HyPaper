import { D, add, mul, gt, lt, lte, gte, isZero } from './math.js';
import { getL2Book } from './l2-cache.js';
import type { L2Level } from './l2-cache.js';
import type { PaperOrder } from '../types/order.js';

interface VwapResult {
  fillPx: string;
  source: 'vwap' | 'fallback';
}

/**
 * Walk order book levels to compute volume-weighted average price.
 *
 * For buys: walk asks (low→high). For sells: walk bids (high→low).
 * Levels beyond limitPx are skipped. If the book lacks depth, the
 * remainder is priced at the worst available level (clamped to limit).
 *
 * Returns fallbackPx when levels are empty/null.
 */
export function computeVwap(
  levels: L2Level[] | null | undefined,
  sz: string,
  isBuy: boolean,
  limitPx: string | null,
  fallbackPx: string,
): VwapResult {
  if (!levels || levels.length === 0) {
    return { fillPx: fallbackPx, source: 'fallback' };
  }

  let totalNotional = D('0');
  let totalFilled = D('0');
  const target = D(sz);

  for (const level of levels) {
    if (totalFilled.gte(target)) break;

    // Skip levels beyond limit price
    if (limitPx !== null) {
      if (isBuy && gt(level.px, limitPx)) break;
      if (!isBuy && lt(level.px, limitPx)) break;
    }

    const available = D(level.sz);
    const remaining = target.minus(totalFilled);
    const filled = available.lte(remaining) ? available : remaining;

    totalNotional = totalNotional.plus(filled.times(D(level.px)));
    totalFilled = totalFilled.plus(filled);
  }

  // Nothing could be filled from the book
  if (totalFilled.isZero()) {
    return { fillPx: fallbackPx, source: 'fallback' };
  }

  // If book lacks depth, price remainder at worst available level
  if (totalFilled.lt(target)) {
    const worstPx = levels[levels.length - 1].px;
    // Clamp worst price to limit if present
    let fillAtPx = worstPx;
    if (limitPx !== null) {
      if (isBuy && gt(worstPx, limitPx)) fillAtPx = limitPx;
      if (!isBuy && lt(worstPx, limitPx)) fillAtPx = limitPx;
    }
    const remaining = target.minus(totalFilled);
    totalNotional = totalNotional.plus(remaining.times(D(fillAtPx)));
    totalFilled = target;
  }

  let vwap = totalNotional.div(totalFilled).toString();

  // Safety clamp: buy VWAP ≤ limitPx, sell VWAP ≥ limitPx
  if (limitPx !== null) {
    if (isBuy && gt(vwap, limitPx)) vwap = limitPx;
    if (!isBuy && lt(vwap, limitPx)) vwap = limitPx;
  }

  return { fillPx: vwap, source: 'vwap' };
}

/**
 * Orchestrator: fetch L2 book, pick the correct side, compute VWAP.
 *
 * @param order     The paper order being filled
 * @param fallbackPx  Price to use when L2 data is unavailable
 * @param limitPx   Limit price for clamping (null = market order, no clamping)
 */
export async function computeFillPrice(
  order: PaperOrder,
  fallbackPx: string,
  limitPx?: string | null,
): Promise<string> {
  const clamp = limitPx === undefined ? order.limitPx : limitPx;

  const book = await getL2Book(order.coin);
  if (!book) return fallbackPx;

  // buys walk asks (index 1), sells walk bids (index 0)
  const levels = order.isBuy ? book.levels[1] : book.levels[0];

  const { fillPx } = computeVwap(levels, order.sz, order.isBuy, clamp, fallbackPx);
  return fillPx;
}
