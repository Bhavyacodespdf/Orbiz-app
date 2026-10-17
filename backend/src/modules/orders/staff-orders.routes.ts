import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import type { OrderStatus, StaffRole } from '../../generated/prisma/enums.js';
import { allowedNextStatuses, transitionOrder } from './transitions.js';
import { recordCounterPayment } from './counter-payment.js';
import { forbidden } from '../../lib/errors.js';
import { markUnsuitable } from '../noshow/noshow.service.js';
import { deliverSoon } from '../notifications/deliver.js';
import { afterOrderChange } from '../kitchen/kitchen.service.js';
import {
  ACTIVE_STATUSES,
  decodeOrderCursor,
  encodeOrderCursor,
  FINISHED_STATUSES,
  orderInclude,
  toOrder,
  toOrderSummary,
} from './orders.serializer.js';

const unsuitableBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

const listQuery = z.object({
  view: z.enum(['active', 'history']).default('active'),
  /** IMMEDIATE or SCHEDULED orders only. */
  timing: z.enum(['IMMEDIATE', 'SCHEDULED']).optional(),
  /** Scheduled orders whose slot is still ahead, or has passed. */
  due: z.enum(['upcoming', 'past_due']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

const counterPaymentBody = z
  .object({
    amountPaise: z.number().int().positive(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

const transitionBody = z
  .object({
    to: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED']),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

function uuidParam(req: Request, name: string) {
  const parsed = z.uuid().safeParse(req.params[name]);
  if (!parsed.success) throw notFound('Order not found');
  return parsed.data;
}

/** The staff roles this user holds AND is assigned with at this outlet. */
async function rolesAtOutlet(db: Database, req: Request, outletId: string): Promise<StaffRole[]> {
  const live = req.auth!.user.roles.filter((r): r is StaffRole => r === 'MANAGER' || r === 'POS');
  const assignments = await db.staffAssignment.findMany({
    where: { userId: req.auth!.user.id, outletId, role: { in: live } },
    select: { role: true },
  });
  return assignments.map((a) => a.role);
}

/**
 * /api/v1/staff/outlets/:outletId/orders — the order queue for assigned
 * Manager/POS staff. Students' contact details are limited to their display name.
 */
export function staffOrdersRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER', 'POS'));

  router.get('/', async (req, res) => {
    const outletId = uuidParam(req, 'outletId');
    const { view, limit, cursor, timing, due } = listQuery.parse(req.query);
    const now = new Date();
    const after = view === 'history' && cursor ? decodeOrderCursor(cursor) : null;
    const rows = await db.order.findMany({
      where: {
        outletId,
        status: { in: [...(view === 'active' ? ACTIVE_STATUSES : FINISHED_STATUSES)] },
        ...(timing && { timing }),
        ...(due && {
          timing: 'SCHEDULED' as const,
          scheduledFor: due === 'upcoming' ? { gt: now } : { lte: now },
        }),
        ...(after && {
          OR: [
            { placedAt: { lt: after.placedAt } },
            { placedAt: after.placedAt, id: { lt: after.id } },
          ],
        }),
      },
      include: {
        outlet: true,
        items: true,
        user: { select: { displayName: true } },
        estimate: true,
      },
      // The live queue is first-come first-served; history is newest first.
      orderBy:
        view === 'active'
          ? [{ placedAt: 'asc' }, { id: 'asc' }]
          : [{ placedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    // The live queue runs in the order food is due: a scheduled order counts from its slot.
    if (view === 'active') {
      const dueAt = (o: (typeof page)[number]) => (o.scheduledFor ?? o.placedAt).getTime();
      page.sort((a, b) => dueAt(a) - dueAt(b) || a.id.localeCompare(b.id));
    }
    res.json({
      orders: page.map((o) => ({
        ...toOrderSummary(o),
        customer: { displayName: o.user.displayName },
        // Approximate queue estimate (kitchen work only; null once ready or finished).
        estimate: o.estimate && {
          queuePosition: o.estimate.queuePosition,
          ordersAhead: o.estimate.ordersAhead,
          prepMinutes: o.estimate.prepMinutes,
          predictedStartAt: o.estimate.predictedStartAt,
          predictedReadyAt: o.estimate.predictedReadyAt,
          delayed:
            o.status === 'PREPARING' &&
            o.estimate.predictedReadyAt.getTime() < now.getTime() - 5 * 60_000,
        },
      })),
      nextCursor:
        view === 'history' && rows.length > limit
          ? encodeOrderCursor(page[page.length - 1]!)
          : null,
    });
  });

  router.get('/:orderId', async (req, res) => {
    const outletId = uuidParam(req, 'outletId');
    const order = await db.order.findFirst({
      where: { id: uuidParam(req, 'orderId'), outletId },
      include: { ...orderInclude, user: { select: { displayName: true } } },
    });
    if (!order) throw notFound('Order not found');
    const roles = await rolesAtOutlet(db, req, outletId);
    res.json({
      order: {
        ...toOrder(order),
        customer: { displayName: order.user.displayName },
        counterPayment: order.counterPayment && {
          amountPaise: order.counterPayment.amountPaise,
          recordedAt: order.counterPayment.recordedAt,
          recordedBy: order.counterPayment.recordedBy.displayName,
        },
        allowedNextStatuses: allowedNextStatuses(order.status, roles),
        canRecordPayment:
          roles.includes('POS') &&
          order.paymentMethod === 'COUNTER' &&
          order.paymentStatus === 'PENDING_COUNTER' &&
          ['ACCEPTED', 'PREPARING', 'READY'].includes(order.status),
      },
    });
  });

  router.post('/:orderId/transition', async (req, res) => {
    const outletId = uuidParam(req, 'outletId');
    const { to, reason } = transitionBody.parse(req.body);
    const result = await transitionOrder(db, {
      orderId: uuidParam(req, 'orderId'),
      to: to as OrderStatus,
      reason,
      actorRoles: await rolesAtOutlet(db, req, outletId),
      actorUserId: req.auth!.user.id,
      scope: { outletId },
    });
    realtime.orderUpdated(result.order, result.ownerId);
    if (result.order.status === 'READY') realtime.orderReady(result.order, result.ownerId);
    deliverSoon(db, realtime);
    await afterOrderChange(db, realtime, outletId, { orderId: result.order.id, to });
    if (result.refunded || result.pointsRestored) realtime.walletUpdated(result.ownerId, 'REFUND');
    for (const userId of result.groupRefundedUserIds) realtime.walletUpdated(userId, 'REFUND');
    if (result.stockRestored.length > 0)
      realtime.stockChanged(result.order.outlet.id, result.stockRestored);
    res.json({ order: result.order });
  });

  /** POS only: record money physically received at the counter. */
  /** Flag a packaged line as not fit to sell again (it won't be restocked on a no-show). */
  router.post('/:orderId/items/:menuItemId/not-resellable', async (req, res) => {
    const outletId = uuidParam(req, 'outletId');
    const { reason } = unsuitableBody.parse(req.body);
    const orderId = await markUnsuitable(db, {
      outletId,
      orderId: uuidParam(req, 'orderId'),
      menuItemId: uuidParam(req, 'menuItemId'),
      reason,
      actorUserId: req.auth!.user.id,
    });
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: orderInclude,
    });
    res.json({ order: toOrder(order) });
  });

  router.post('/:orderId/counter-payment', async (req, res) => {
    const outletId = uuidParam(req, 'outletId');
    if (!(await rolesAtOutlet(db, req, outletId)).includes('POS')) {
      throw forbidden('Only POS staff can record counter payments.');
    }
    const body = counterPaymentBody.parse(req.body);
    const result = await recordCounterPayment(db, {
      outletId,
      orderId: uuidParam(req, 'orderId'),
      amountPaise: body.amountPaise,
      note: body.note,
      actorUserId: req.auth!.user.id,
    });
    realtime.orderUpdated(result.order, result.ownerId);
    res.json({ order: result.order });
  });

  return router;
}
