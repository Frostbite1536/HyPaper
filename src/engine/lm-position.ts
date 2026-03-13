import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, isZero } from '../utils/math.js';
import type { LmPaperOrder } from '../types/limitless-order.js';

export interface LmPortfolioPosition {
  marketSlug: string;
  marketTitle: string;
  deadline: string;
  yesBalance: string;
  noBalance: string;
  yesCost: string;
  noCost: string;
  yesAvgPrice: string;
  noAvgPrice: string;
  currentYesPrice: string;
  currentNoPrice: string;
  yesUnrealizedPnl: string;
  noUnrealizedPnl: string;
  totalUnrealizedPnl: string;
  totalMarketValue: string;
}

export interface LmPortfolio {
  balance: string;
  totalUnrealizedPnl: string;
  totalMarketValue: string;
  accountValue: string;
  positions: LmPortfolioPosition[];
}

export async function getLmPortfolio(userId: string): Promise<LmPortfolio> {
  const balance = (await redis.hget(KEYS.LM_USER_ACCOUNT(userId), 'balance')) ?? '0';
  const slugs = await redis.smembers(KEYS.LM_USER_POSITIONS(userId));

  const positions: LmPortfolioPosition[] = [];
  let totalUnrealizedPnl = '0';
  let totalMarketValue = '0';

  for (const slug of slugs) {
    const posData = await redis.hgetall(KEYS.LM_USER_POS(userId, slug));
    if (isZero(posData.yesBalance ?? '0') && isZero(posData.noBalance ?? '0')) continue;

    const yesBalance = posData.yesBalance ?? '0';
    const noBalance = posData.noBalance ?? '0';
    const yesCost = posData.yesCost ?? '0';
    const noCost = posData.noCost ?? '0';
    const yesAvgPrice = posData.yesAvgPrice ?? '0';
    const noAvgPrice = posData.noAvgPrice ?? '0';

    // Get current prices
    const pricesRaw = await redis.hget(KEYS.LM_MARKET_PRICES, slug);
    let currentYesPrice = '0';
    let currentNoPrice = '0';
    if (pricesRaw) {
      const prices = JSON.parse(pricesRaw);
      currentYesPrice = prices.yes ?? '0';
      currentNoPrice = prices.no ?? '0';
    }

    // Get market metadata
    const marketRaw = await redis.hget(KEYS.LM_MARKETS, slug);
    let marketTitle = slug;
    let deadline = '';
    if (marketRaw) {
      const market = JSON.parse(marketRaw);
      marketTitle = market.title ?? slug;
      deadline = market.expirationDate ?? '';
    }

    // Calculate unrealized PnL
    const yesUnrealizedPnl = isZero(yesBalance)
      ? '0'
      : mul(sub(currentYesPrice, yesAvgPrice), yesBalance);
    const noUnrealizedPnl = isZero(noBalance)
      ? '0'
      : mul(sub(currentNoPrice, noAvgPrice), noBalance);
    const posUnrealizedPnl = add(yesUnrealizedPnl, noUnrealizedPnl);

    // Market value
    const yesValue = mul(yesBalance, currentYesPrice);
    const noValue = mul(noBalance, currentNoPrice);
    const posMarketValue = add(yesValue, noValue);

    totalUnrealizedPnl = add(totalUnrealizedPnl, posUnrealizedPnl);
    totalMarketValue = add(totalMarketValue, posMarketValue);

    positions.push({
      marketSlug: slug,
      marketTitle,
      deadline,
      yesBalance,
      noBalance,
      yesCost,
      noCost,
      yesAvgPrice,
      noAvgPrice,
      currentYesPrice,
      currentNoPrice,
      yesUnrealizedPnl,
      noUnrealizedPnl,
      totalUnrealizedPnl: posUnrealizedPnl,
      totalMarketValue: posMarketValue,
    });
  }

  const accountValue = add(balance, totalMarketValue);

  return {
    balance,
    totalUnrealizedPnl,
    totalMarketValue,
    accountValue,
    positions,
  };
}

export async function getLmOpenOrders(userId: string): Promise<LmPaperOrder[]> {
  // Use the global open orders set and filter by userId for efficiency
  const openOids = await redis.smembers(KEYS.LM_ORDERS_OPEN);
  const openOrders: LmPaperOrder[] = [];

  for (const oidStr of openOids) {
    const oid = parseInt(oidStr, 10);
    const data = await redis.hgetall(KEYS.LM_ORDER(oid));
    if (!data.oid || data.userId !== userId) continue;

    openOrders.push({
      oid,
      userId: data.userId,
      marketSlug: data.marketSlug,
      outcome: data.outcome as 'yes' | 'no',
      side: data.side as 'buy' | 'sell',
      price: data.price,
      size: data.size,
      orderType: data.orderType as 'limit' | 'market',
      status: 'open',
      filledSize: data.filledSize ?? '0',
      avgFillPrice: data.avgFillPrice ?? '0',
      createdAt: parseInt(data.createdAt, 10),
      updatedAt: parseInt(data.updatedAt, 10),
    });
  }

  return openOrders;
}

export async function getLmBalance(userId: string): Promise<string> {
  const balance = await redis.hget(KEYS.LM_USER_ACCOUNT(userId), 'balance');
  return balance ?? '0';
}
