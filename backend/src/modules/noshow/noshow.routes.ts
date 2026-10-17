import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireRole } from '../../middleware/auth.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { orderInclude, toOrder } from '../orders/orders.serializer.js';
import { processNoShow } from './noshow.service.js';

const listQuery = z.object({ status: z.enum(['FAILED', 'PROCESSED']).default('FAILED') });

/**
 * /admin/no-shows — recovery for the automatic no-show policy (ADMIN only, audited).
 * An admin can see settlements and re-run the SAME policy for an order whose processing
 * failed. There is deliberately no way to enter a refund amount: the policy computes it.
 */
export function adminNoShowRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireRole('ADMIN'));

  router.get('/', async (req, res) => {
    const { status } = listQuery.parse(req.query);
    const rows = await db.noShowSettlement.findMany({
      where: { status },
      include: { order: { include: { outlet: { select: { name: true } } } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    res.json({
      settlements: rows.map((r) => ({
        orderId: r.orderId,
        pickupCode: r.order.pickupCode,
        outlet: r.order.outlet.name,
        orderStatus: r.order.status,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        pickupDeadline: r.pickupDeadline,
        processedAt: r.processedAt,
        refundPaise: r.refundPaise,
        convenienceFeePaise: r.convenienceFeePaise,
        restockedUnits: r.restockedUnits,
        updatedAt: r.updatedAt,
      })),
    });
  });

  router.post('/:orderId/retry', async (req, res) => {
    const orderId = z.uuid().safeParse(req.params.orderId);
    if (!orderId.success) throw notFound('Order not found');
    const order = await db.order.findUnique({ where: { id: orderId.data } });
    if (!order || order.timing !== 'SCHEDULED') throw notFound('Order not found');
    await recordAudit(db, {
      actor: { type: 'USER', userId: req.auth!.user.id },
      action: 'NO_SHOW_RETRY_REQUESTED',
      entityType: 'Order',
      entityId: order.id,
    });
    const outcome = await processNoShow(db, order.id, { type: 'ADMIN', userId: req.auth!.user.id });
    const fresh = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      include: orderInclude,
    });
    if (outcome) {
      realtime.orderUpdated(toOrder(fresh), outcome.userId);
      if (outcome.refundPaise > 0) realtime.walletUpdated(outcome.userId, 'REFUND');
      if (outcome.restockedItemIds.length > 0)
        realtime.stockChanged(outcome.outletId, outcome.restockedItemIds);
    }
    // processed: settled now; false: nothing to do (collected, not due yet, or already settled).
    res.json({ processed: Boolean(outcome), order: toOrder(fresh) });
  });

  return router;
}
