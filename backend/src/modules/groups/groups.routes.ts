import { Router, type Request } from 'express';
import { deliverSoon } from '../notifications/deliver.js';
import { afterOrderChange } from '../kitchen/kitchen.service.js';
import { decideAutoAccept } from '../autoaccept/autoaccept.service.js';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import type { Env } from '../../config/env.js';
import { AppError, notFound } from '../../lib/errors.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import { logger } from '../../lib/logger.js';
import { requireRole } from '../../middleware/auth.js';
import { moneyActionLimiter } from '../../middleware/rate-limit.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { orderInclude, toOrder } from '../orders/orders.serializer.js';
import {
  cancelGroup,
  createGroup,
  getGroup,
  joinGroup,
  listGroups,
  MAX_ITEM_QUANTITY,
  memberUserIds,
  payMyShare,
  placeGroupOrder,
  removeMember,
  reopenGroup,
  setAllocation,
  setMyItem,
  startCheckout,
  updateGroup,
} from './groups.service.js';

const modes = z.enum(['BY_DISH', 'EQUAL', 'PERCENTAGE', 'CUSTOM']);
const name = z.string().trim().min(1, 'Give the group a name').max(60);
const description = z.string().trim().max(300);
const maxMembers = z.number().int().min(2).max(20);
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

const createBody = z
  .object({
    name,
    description: description.optional(),
    outletId: z.uuid(),
    maxMembers: maxMembers.default(8),
    joinClosesAt: instant.nullable().optional(),
    allocationMode: modes.default('BY_DISH'),
  })
  .strict();
const updateBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    maxMembers: maxMembers.optional(),
    joinClosesAt: instant.nullable().optional(),
  })
  .strict();
const joinBody = z.object({ code: z.string().trim().min(4).max(40) }).strict();
const itemBody = z.object({ quantity: z.number().int().min(0).max(MAX_ITEM_QUANTITY) }).strict();
const idMap = (value: z.ZodNumber) => z.record(z.uuid(), value);
const allocationBody = z
  .object({
    mode: modes,
    percents: idMap(z.number().int().min(0).max(10_000)).optional(),
    amounts: idMap(z.number().int().min(0).max(10_000_000)).optional(),
  })
  .strict()
  .refine((b) => b.mode !== 'PERCENTAGE' || b.percents, {
    message: 'Give each member a percentage',
    path: ['percents'],
  })
  .refine((b) => b.mode !== 'CUSTOM' || b.amounts, {
    message: 'Give each member an amount',
    path: ['amounts'],
  });
const checkoutBody = z.object({ expectedTotalPaise: z.number().int().positive() }).strict();
const cancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

function idParam(req: Request, key: string) {
  const parsed = z.uuid().safeParse(req.params[key]);
  if (!parsed.success) throw notFound('Group not found');
  return parsed.data;
}

/** Guessing join codes: at most 20 attempts per person per 10 minutes. */
function joinLimiter() {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) =>
      req.auth ? `user:${req.auth.user.id}` : `ip:${ipKeyGenerator(req.ip ?? '')}`,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'RATE_LIMITED', 'Too many join attempts. Please wait a few minutes.')),
  });
}

/** /api/v1/groups — group trays. Every group route requires ACTIVE membership of that group. */
export function groupsRouter(db: Database, realtime: RealtimePublisher, config: Env) {
  const router = Router();
  // Money-moving steps share the app's per-user money limit; tray edits don't.
  const moneyLimit = moneyActionLimiter(config);
  router.use(requireRole('STUDENT'));

  const notify = async (groupId: string, extra: string[] = []) => {
    const ids = await memberUserIds(db, groupId);
    realtime.socialChanged([...ids, ...extra], { kind: 'GROUP', id: groupId });
  };
  const respond = async (req: Request, groupId: string) => getGroup(db, groupId, req.auth!.user.id);

  router.get('/', async (req, res) => {
    res.json({ groups: await listGroups(db, req.auth!.user.id) });
  });

  router.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    const groupId = await createGroup(db, { ...body, userId: req.auth!.user.id });
    res.status(201).json({ group: await respond(req, groupId) });
  });

  router.post('/join', joinLimiter(), async (req, res) => {
    const { code } = joinBody.parse(req.body);
    const groupId = await joinGroup(db, code, req.auth!.user.id);
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  router.get('/:groupId', async (req, res) => {
    res.json({ group: await respond(req, idParam(req, 'groupId')) });
  });

  router.patch('/:groupId', async (req, res) => {
    const groupId = idParam(req, 'groupId');
    await updateGroup(db, { groupId, userId: req.auth!.user.id, ...updateBody.parse(req.body) });
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  router.delete('/:groupId/members/:memberId', async (req, res) => {
    const groupId = idParam(req, 'groupId');
    const removed = await removeMember(db, {
      groupId,
      userId: req.auth!.user.id,
      memberId: idParam(req, 'memberId'),
    });
    await notify(groupId, [removed]);
    if (removed === req.auth!.user.id) res.status(204).end();
    else res.json({ group: await respond(req, groupId) });
  });

  router.put('/:groupId/items/:menuItemId', async (req, res) => {
    const groupId = idParam(req, 'groupId');
    const { quantity } = itemBody.parse(req.body);
    await setMyItem(db, {
      groupId,
      userId: req.auth!.user.id,
      menuItemId: idParam(req, 'menuItemId'),
      quantity,
    });
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  router.put('/:groupId/allocation', async (req, res) => {
    const groupId = idParam(req, 'groupId');
    await setAllocation(db, {
      groupId,
      userId: req.auth!.user.id,
      ...allocationBody.parse(req.body),
    });
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  router.post('/:groupId/checkout', moneyLimit, async (req, res) => {
    const groupId = idParam(req, 'groupId');
    const { expectedTotalPaise } = checkoutBody.parse(req.body);
    await startCheckout(db, { groupId, userId: req.auth!.user.id, expectedTotalPaise });
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  /** Places the order (after the last payment it is tried automatically). */
  async function tryPlace(groupId: string, actorUserId: string | null) {
    const result = await placeGroupOrder(db, {
      groupId,
      actorUserId,
      capacityLimit: config.ORDER_CAPACITY_PER_WINDOW,
    });
    if (result.created) {
      const order = await db.order.findUniqueOrThrow({
        where: { id: result.orderId },
        include: orderInclude,
      });
      realtime.orderCreated(toOrder(order), order.userId);
      deliverSoon(db, realtime);
      await afterOrderChange(db, realtime, order.outletId);
      await decideAutoAccept(db, realtime, order.id).catch(() => null);
      realtime.stockChanged(
        order.outletId,
        order.items.map((i) => i.menuItemId),
      );
    }
    return result;
  }

  router.post('/:groupId/shares/mine/pay', moneyLimit, async (req, res) => {
    requireIdempotencyKey(req); // the ledger key per share is what actually prevents double charges
    const groupId = idParam(req, 'groupId');
    const userId = req.auth!.user.id;
    const result = await payMyShare(db, { groupId, userId });
    if (result.paid) realtime.walletUpdated(userId, 'GROUP_SHARE');
    let orderError: unknown = null;
    if (result.paid && result.allPaid) {
      try {
        await tryPlace(groupId, null);
      } catch (err) {
        // Payment stands; the host is told and can retry or reopen (which refunds everyone).
        orderError = err;
        logger.warn({ err, groupId }, 'Group order could not be placed after the last payment');
        await db.groupEvent.create({
          data: {
            groupId,
            kind: 'ORDER_FAILED',
            details: { message: err instanceof AppError ? err.message : 'Unexpected error' },
          },
        });
      }
    }
    await notify(groupId);
    res.status(result.paid ? 201 : 200).json({
      group: await respond(req, groupId),
      orderError:
        orderError instanceof AppError
          ? { code: orderError.code, message: orderError.message }
          : orderError
            ? { code: 'ORDER_FAILED', message: 'The order couldn’t be placed yet.' }
            : null,
    });
  });

  router.post('/:groupId/order', moneyLimit, async (req, res) => {
    const groupId = idParam(req, 'groupId');
    await tryPlace(groupId, req.auth!.user.id);
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  router.post('/:groupId/reopen', moneyLimit, async (req, res) => {
    const groupId = idParam(req, 'groupId');
    const refunded = await reopenGroup(db, { groupId, userId: req.auth!.user.id });
    for (const id of refunded) realtime.walletUpdated(id, 'REFUND');
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  router.post('/:groupId/cancel', moneyLimit, async (req, res) => {
    const groupId = idParam(req, 'groupId');
    const { reason } = cancelBody.parse(req.body);
    const refunded = await cancelGroup(db, { groupId, userId: req.auth!.user.id, reason });
    for (const id of refunded) realtime.walletUpdated(id, 'REFUND');
    await notify(groupId);
    res.json({ group: await respond(req, groupId) });
  });

  return router;
}
