import { Hono } from 'hono';
import { placeOrders, cancelOrders, cancelByCloid, updateLeverage } from '../../engine/order.js';
import { logger } from '../../utils/logger.js';
import type { HlExchangeAction } from '../../types/hl.js';

export const exchangeRouter = new Hono();

exchangeRouter.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  // HL exchange requests have: action, nonce, signature, vaultAddress
  // We only care about action
  const action: HlExchangeAction = body.action;
  if (!action) {
    return c.json({ status: 'err', response: 'Missing action' }, 400);
  }

  try {
    switch (action.type) {
      case 'order': {
        const statuses = await placeOrders(userId, action.orders, action.grouping);
        return c.json({
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses },
          },
        });
      }

      case 'cancel': {
        const statuses = await cancelOrders(userId, action.cancels);
        return c.json({
          status: 'ok',
          response: {
            type: 'cancel',
            data: { statuses },
          },
        });
      }

      case 'cancelByCloid': {
        const statuses = await cancelByCloid(userId, action.cancels);
        return c.json({
          status: 'ok',
          response: {
            type: 'cancel',
            data: { statuses },
          },
        });
      }

      case 'updateLeverage': {
        await updateLeverage(userId, action.asset, action.isCross, action.leverage);
        return c.json({
          status: 'ok',
          response: { type: 'default' },
        });
      }

      default: {
        return c.json({
          status: 'err',
          response: `Unsupported action type: ${(action as { type: string }).type}`,
        }, 400);
      }
    }
  } catch (err) {
    logger.error({ err, action: action.type }, 'Exchange error');
    return c.json({ status: 'err', response: String(err) }, 500);
  }
});
