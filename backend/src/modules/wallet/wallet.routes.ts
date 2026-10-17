import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import { requireRole } from '../../middleware/auth.js';
import { rechargeProviderFor } from '../payments/providers.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import {
  createRecharge,
  getRecharge,
  getTransaction,
  getWalletSummary,
  listTransactions,
} from './wallet.service.js';
import { listLoyaltyTransactions } from '../loyalty/loyalty.service.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
const rechargeBody = z.object({ amountPaise: z.number().int().positive() }).strict();

function uuid(value: unknown, what: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
}

/**
 * /api/v1/wallet — the signed-in user's own wallet. There is deliberately no
 * endpoint that sets a balance or creates a credit/debit directly.
 */
export function walletRouter(db: Database, config: Env, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireRole('STUDENT'));
  const provider = rechargeProviderFor(config);

  router.get('/', async (req, res) => {
    res.json({ wallet: await getWalletSummary(db, req.auth!.user.id, config, provider) });
  });

  router.get('/transactions', async (req, res) => {
    const query = listQuery.parse(req.query);
    res.json(await listTransactions(db, req.auth!.user.id, query));
  });

  router.get('/transactions/:transactionId', async (req, res) => {
    const id = uuid(req.params.transactionId, 'Transaction');
    res.json({ transaction: await getTransaction(db, req.auth!.user.id, id) });
  });

  /** The student's own loyalty-points ledger, newest first. */
  router.get('/points', async (req, res) => {
    const query = listQuery.parse(req.query);
    res.json(await listLoyaltyTransactions(db, req.auth!.user.id, query));
  });

  router.post('/recharges', async (req, res) => {
    const idempotencyKey = requireIdempotencyKey(req);
    const { amountPaise } = rechargeBody.parse(req.body);
    const { recharge, created } = await createRecharge(db, {
      userId: req.auth!.user.id,
      amountPaise,
      idempotencyKey,
      limits: config,
      provider,
    });
    if (created) realtime.walletUpdated(req.auth!.user.id, 'RECHARGE'); // a pending entry appeared
    res.status(created ? 201 : 200).json({
      recharge,
      nextAction: recharge.status === 'PENDING' && provider ? { type: 'MOCK_SIMULATOR' } : null,
    });
  });

  router.get('/recharges/:rechargeId', async (req, res) => {
    const id = uuid(req.params.rechargeId, 'Recharge');
    res.json({ recharge: await getRecharge(db, req.auth!.user.id, id) });
  });

  return router;
}
