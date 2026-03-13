import { Hono } from 'hono';
import { placeLmOrder, cancelLmOrder, cancelAllLmOrders, ensureLmAccount } from '../../engine/lm-order.js';
import { logger } from '../../utils/logger.js';

export const lmExchangeRouter = new Hono();

lmExchangeRouter.post('/', async (c) => {
  const body = await c.req.json();

  const rawWallet: string | undefined = body.wallet;
  if (!rawWallet || typeof rawWallet !== 'string') {
    return c.json({ status: 'err', response: 'Missing wallet address' }, 400);
  }
  const wallet = rawWallet.toLowerCase();
  await ensureLmAccount(wallet);

  const action = body.action;
  if (!action || typeof action !== 'object' || !action.type) {
    return c.json({ status: 'err', response: 'Missing or invalid action' }, 400);
  }

  try {
    switch (action.type) {
      case 'order': {
        // Validate required fields
        if (!action.marketSlug || typeof action.marketSlug !== 'string') {
          return c.json({ status: 'err', response: 'Missing marketSlug' }, 400);
        }
        if (action.outcome !== 'yes' && action.outcome !== 'no') {
          return c.json({ status: 'err', response: 'outcome must be "yes" or "no"' }, 400);
        }
        if (action.side !== 'buy' && action.side !== 'sell') {
          return c.json({ status: 'err', response: 'side must be "buy" or "sell"' }, 400);
        }
        if (!action.price || typeof action.price !== 'string') {
          return c.json({ status: 'err', response: 'Missing price (string)' }, 400);
        }
        if (!action.size || typeof action.size !== 'string') {
          return c.json({ status: 'err', response: 'Missing size (string)' }, 400);
        }
        if (action.orderType !== 'limit' && action.orderType !== 'market') {
          return c.json({ status: 'err', response: 'orderType must be "limit" or "market"' }, 400);
        }

        const result = await placeLmOrder(
          wallet, action.marketSlug, action.outcome,
          action.side, action.price, action.size, action.orderType,
        );
        if (result.status === 'error') {
          return c.json({ status: 'err', response: result.message }, 400);
        }
        return c.json({ status: 'ok', response: { oid: result.oid } });
      }

      case 'cancel': {
        if (typeof action.orderId !== 'number') {
          return c.json({ status: 'err', response: 'Missing orderId (number)' }, 400);
        }
        const result = await cancelLmOrder(wallet, action.orderId);
        if (result.status === 'error') {
          return c.json({ status: 'err', response: result.message }, 400);
        }
        return c.json({ status: 'ok', response: { type: 'cancel' } });
      }

      case 'cancelAll': {
        if (!action.marketSlug || typeof action.marketSlug !== 'string') {
          return c.json({ status: 'err', response: 'Missing marketSlug' }, 400);
        }
        const result = await cancelAllLmOrders(wallet, action.marketSlug);
        return c.json({ status: 'ok', response: { cancelled: result.cancelled } });
      }

      default:
        return c.json({ status: 'err', response: `Unsupported action type: ${action.type}` }, 400);
    }
  } catch (err) {
    logger.error({ err, action: action.type }, 'LM exchange error');
    return c.json({ status: 'err', response: String(err) }, 500);
  }
});
