import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { settleRecharge } from '../wallet/wallet.service.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';

const outcomeBody = z.object({ outcome: z.enum(['SUCCESS', 'FAILURE', 'CANCEL']) }).strict();

/**
 * POST /api/v1/payments/mock/:attemptId/outcome — TEST MODE ONLY.
 *
 * Stands in for a payment provider's callback so the recharge flow can be
 * exercised without real money. Only mounted when mock payments are enabled
 * (never in production), and only the attempt's owner can settle it.
 */
export function mockPaymentsRouter(db: Database, config: Env, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.post('/:attemptId/outcome', async (req, res) => {
    const attemptId = z.uuid().safeParse(req.params.attemptId);
    if (!attemptId.success) throw notFound('Recharge not found');
    const { outcome } = outcomeBody.parse(req.body);
    const result = await settleRecharge(db, {
      userId: req.auth!.user.id,
      attemptId: attemptId.data,
      outcome,
      limits: config,
    });
    if (result.changed) realtime.walletUpdated(req.auth!.user.id, 'RECHARGE');
    res.json(result);
  });

  return router;
}
