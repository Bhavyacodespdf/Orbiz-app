import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import type { Env } from '../../config/env.js';
import { notFound } from '../../lib/errors.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import { requireRole } from '../../middleware/auth.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import {
  cancelSplit,
  createSplit,
  getSplit,
  listSplits,
  MAX_PARTICIPANTS,
  participantIds,
  settleShare,
  updateSplit,
} from './splits.service.js';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => {
    const date = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
  }, 'Not a real date');
const title = z.string().trim().min(1, 'Give the expense a title').max(80);
const description = z.string().trim().max(500);

const createBody = z
  .object({
    title,
    description: description.optional(),
    totalPaise: z.number().int().min(100).max(10_000_000),
    expenseDate: day,
    dueDate: day.nullable().optional(),
    method: z.enum(['EQUAL', 'PERCENTAGE', 'CUSTOM']),
    participants: z
      .array(
        z
          .object({
            email: z.email(),
            percentBps: z.number().int().min(0).max(10_000).optional(),
            customAmountPaise: z.number().int().min(0).max(10_000_000).optional(),
          })
          .strict(),
      )
      .min(2, 'Add at least two people, including anyone else who shared the cost')
      .max(MAX_PARTICIPANTS),
  })
  .strict()
  .refine((b) => !b.dueDate || b.dueDate >= b.expenseDate, {
    message: 'The due date can’t be before the expense',
    path: ['dueDate'],
  });
const updateBody = z
  .object({
    title: title.optional(),
    description: description.optional(),
    dueDate: day.nullable().optional(),
  })
  .strict();
const settleBody = z.object({ amountPaise: z.number().int().min(1).max(10_000_000) }).strict();
const cancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

function idParam(req: Request) {
  const parsed = z.uuid().safeParse(req.params.splitId);
  if (!parsed.success) throw notFound('Split not found');
  return parsed.data;
}

/** /api/v1/splits — peer expense splits. Only the owner and participants can see a split. */
export function splitsRouter(db: Database, realtime: RealtimePublisher, config: Env) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  const notify = async (splitId: string) =>
    realtime.socialChanged(await participantIds(db, splitId), { kind: 'SPLIT', id: splitId });

  router.get('/', async (req, res) => {
    res.json({ splits: await listSplits(db, req.auth!.user.id) });
  });

  router.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    const id = await createSplit(
      db,
      { ...body, ownerUserId: req.auth!.user.id },
      config.WALLET_MAX_BALANCE_PAISE,
    );
    await notify(id);
    res.status(201).json({ split: await getSplit(db, id, req.auth!.user.id) });
  });

  router.get('/:splitId', async (req, res) => {
    res.json({ split: await getSplit(db, idParam(req), req.auth!.user.id) });
  });

  router.patch('/:splitId', async (req, res) => {
    const splitId = idParam(req);
    await updateSplit(db, { splitId, userId: req.auth!.user.id, ...updateBody.parse(req.body) });
    await notify(splitId);
    res.json({ split: await getSplit(db, splitId, req.auth!.user.id) });
  });

  router.post('/:splitId/settlements', async (req, res) => {
    const splitId = idParam(req);
    const idempotencyKey = requireIdempotencyKey(req);
    const { amountPaise } = settleBody.parse(req.body);
    const userId = req.auth!.user.id;
    const result = await settleShare(db, {
      splitId,
      userId,
      amountPaise,
      idempotencyKey,
      maxBalancePaise: config.WALLET_MAX_BALANCE_PAISE,
    });
    if (result.created) {
      realtime.walletUpdated(userId, 'TRANSFER');
      realtime.walletUpdated(result.recipientUserId, 'TRANSFER');
      await notify(splitId);
    }
    res.status(result.created ? 201 : 200).json({ split: await getSplit(db, splitId, userId) });
  });

  router.post('/:splitId/cancel', async (req, res) => {
    const splitId = idParam(req);
    const { reason } = cancelBody.parse(req.body);
    const result = await cancelSplit(db, { splitId, userId: req.auth!.user.id, reason });
    if (result.reversedPayers.length > 0) {
      realtime.walletUpdated(req.auth!.user.id, 'TRANSFER');
      for (const id of result.reversedPayers) realtime.walletUpdated(id, 'TRANSFER');
    }
    realtime.socialChanged([req.auth!.user.id, ...result.userIds], { kind: 'SPLIT', id: splitId });
    res.json({ split: await getSplit(db, splitId, req.auth!.user.id) });
  });

  return router;
}
