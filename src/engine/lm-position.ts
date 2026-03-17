import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, isZero } from '../utils/math.js';
import { logger } from '../utils/logger.js';
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

  if (slugs.length > 0) {
    // Pipeline all reads to avoid N+1
    const pipeline = redis.pipeline();
    for (const slug of slugs) {
      pipeline.hgetall(KEYS.LM_USER_POS(userId, slug));
      pipeline.hget(KEYS.LM_MARKET_PRICES, slug);
      pipeline.hget(KEYS.LM_MARKETS, slug);
    }
    const results = await pipeline.exec();
    if (!results) {
      logger.warn({ userId }, 'LM portfolio pipeline returned null');
      return { positions, balance, totalUnrealizedPnl, totalMarketValue, accountValue: balance };
    }

    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      const [, posData] = results[i * 3] as [Error | null, Record<string, string>];
      const [, pricesRaw] = results[i * 3 + 1] as [Error | null, string | null];
      const [, marketRaw] = results[i * 3 + 2] as [Error | null, string | null];

      if (!posData || (isZero(posData.yesBalance ?? '0') && isZero(posData.noBalance ?? '0'))) continue;

      const yesBalance = posData.yesBalance ?? '0';
      const noBalance = posData.noBalance ?? '0';
      const yesCost = posData.yesCost ?? '0';
      const noCost = posData.noCost ?? '0';
      const yesAvgPrice = posData.yesAvgPrice ?? '0';
      const noAvgPrice = posData.noAvgPrice ?? '0';

      let currentYesPrice = '0';
      let currentNoPrice = '0';
      if (pricesRaw) {
        try {
          const prices = JSON.parse(pricesRaw);
          currentYesPrice = prices.yes ?? '0';
          currentNoPrice = prices.no ?? '0';
        } catch {
          logger.warn({ slug }, 'LM corrupted price data in portfolio');
        }
      }

      let marketTitle = slug;
      let deadline = '';
      if (marketRaw) {
        try {
          const market = JSON.parse(marketRaw);
          marketTitle = market.title ?? slug;
          deadline = market.expirationDate ?? '';
        } catch {
          logger.warn({ slug }, 'LM corrupted market data in portfolio');
        }
      }

      const yesUnrealizedPnl = isZero(yesBalance)
        ? '0'
        : mul(sub(currentYesPrice, yesAvgPrice), yesBalance);
      const noUnrealizedPnl = isZero(noBalance)
        ? '0'
        : mul(sub(currentNoPrice, noAvgPrice), noBalance);
      const posUnrealizedPnl = add(yesUnrealizedPnl, noUnrealizedPnl);

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
  const openOids = await redis.smembers(KEYS.LM_ORDERS_OPEN);
  if (openOids.length === 0) return [];

  // Pipeline all reads to avoid N+1
  const pipeline = redis.pipeline();
  for (const oidStr of openOids) {
    pipeline.hgetall(KEYS.LM_ORDER(parseInt(oidStr, 10)));
  }
  const results = await pipeline.exec();

  const openOrders: LmPaperOrder[] = [];
  for (let i = 0; i < openOids.length; i++) {
    const [err, data] = results![i] as [Error | null, Record<string, string>];
    if (err || !data || !data.oid || data.userId !== userId) continue;

    openOrders.push({
      oid: parseInt(data.oid, 10),
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
