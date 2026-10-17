import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import { MAX_STOCK, stockStatus, STOCK_STATUSES } from '../inventory/stock.js';
import { demandOf } from './demand.service.js';
import { metricsOf } from './forecast.service.js';
import { activePolicy } from './policy.js';
import { addDays, asDate, dayOf, daysBetween, nextMonday, todayIst } from './dates.js';
import {
  HISTORY_DAYS,
  MAX_HISTORY_RANGE_DAYS,
  MAX_WEEKS_AHEAD,
  POLICY_NAME,
} from './planning.rules.js';
import {
  generatePlan,
  getPlan,
  listPlans,
  planCsv,
  recordReplenishment,
  transitionPlan,
  updatePlanItem,
  updatePlanNotes,
  type PlanActor,
} from './plan.service.js';

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(
    (d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && dayOf(asDate(d)) === d,
    'Not a real date',
  );

const historyQuery = z
  .object({
    from: isoDay,
    to: isoDay,
    menuItemId: uuidParam.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    cursor: z.string().max(200).optional(),
  })
  .refine((q) => q.from <= q.to, { message: '"from" must not be after "to"', path: ['from'] })
  .refine((q) => daysBetween(q.from, q.to) < MAX_HISTORY_RANGE_DAYS, {
    message: `At most ${MAX_HISTORY_RANGE_DAYS} days per request`,
    path: ['to'],
  });

const weekQuery = z.object({ weekStart: isoDay.optional() });
const generateBody = z.object({ weekStart: isoDay }).strict();
const itemBody = z
  .object({
    finalQty: z.number().int().min(0).max(MAX_STOCK),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();
const notesBody = z.object({ notes: z.string().trim().max(2000) }).strict();
const replenishBody = z.object({ quantity: z.number().int().min(1).max(MAX_STOCK) }).strict();
const itemHistoryQuery = z.object({
  days: z.coerce.number().int().min(7).max(MAX_HISTORY_RANGE_DAYS).default(HISTORY_DAYS),
});

function idParam(req: Request, name: string): string {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** Keyset cursor over (businessDate, menuItemId). */
const encodeCursor = (date: string, itemId: string) =>
  Buffer.from(`${date}|${itemId}`).toString('base64url');
function decodeCursor(cursor: string) {
  const [date, itemId] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!date || !itemId || !isoDay.safeParse(date).success || !uuidParam.safeParse(itemId).success) {
    throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
  }
  return { date, itemId };
}

/**
 * /api/v1/staff/outlets/:outletId/planning — the Weekly Stock Planner, for staff assigned to
 * the outlet (MANAGER or POS). Everything is scoped by the outletId in the path, checked
 * against the caller's assignment; IDs from the client are only ever looked up within it.
 */
export function planningRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER', 'POS'));

  async function actorFor(req: Request, outletId: string): Promise<PlanActor> {
    const live = req.auth!.user.roles.filter((r) => r === 'MANAGER' || r === 'POS');
    const assignments = await db.staffAssignment.findMany({
      where: { userId: req.auth!.user.id, outletId, role: { in: live as ('MANAGER' | 'POS')[] } },
      select: { role: true },
    });
    const roles = assignments.map((a) => a.role);
    // The most privileged role held here: approving needs MANAGER.
    return { userId: req.auth!.user.id, role: roles.includes('MANAGER') ? 'MANAGER' : 'POS' };
  }

  /** The planner's landing data: the week, its live plan, stock status and data sufficiency. */
  router.get('/overview', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const today = todayIst();
    const first = nextMonday(today);
    const { weekStart = first } = weekQuery.parse(req.query);
    const [live, items, latestRun, lastComputed, activeDays, policy, actor] = await Promise.all([
      db.stockPlan.findFirst({
        where: { outletId, weekStart: asDate(weekStart), status: { not: 'SUPERSEDED' } },
        select: { id: true },
      }),
      db.menuItem.findMany({
        where: { outletId, isActive: true },
        select: {
          isAvailable: true,
          trackInventory: true,
          stockQuantity: true,
          lowStockThreshold: true,
        },
      }),
      db.forecastRun.findFirst({
        where: { outletId, weekStart: asDate(weekStart) },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          asOfDate: true,
          trigger: true,
          model: true,
          modelVersion: true,
        },
      }),
      db.demandDaily.aggregate({ where: { outletId }, _max: { computedAt: true } }),
      db.demandDaily.findMany({
        where: {
          outletId,
          outletActive: true,
          businessDate: { gte: asDate(addDays(today, -HISTORY_DAYS)), lt: asDate(today) },
        },
        distinct: ['businessDate'],
        select: { businessDate: true },
      }),
      activePolicy(db),
      actorFor(req, outletId),
    ]);
    const counts = Object.fromEntries(STOCK_STATUSES.map((s) => [s, 0])) as Record<
      (typeof STOCK_STATUSES)[number],
      number
    >;
    for (const item of items) counts[stockStatus(item)] += 1;
    res.json({
      week: {
        start: weekStart,
        end: addDays(weekStart, 6),
        firstPlannable: first,
        lastPlannable: addDays(first, 7 * (MAX_WEEKS_AHEAD - 1)),
      },
      role: actor.role,
      plan: live ? await getPlan(db, outletId, live.id) : null,
      stock: counts,
      latestForecast: latestRun
        ? {
            ...latestRun,
            createdAt: latestRun.createdAt.toISOString(),
            asOfDate: dayOf(latestRun.asOfDate),
          }
        : null,
      demandUpdatedAt: lastComputed._max.computedAt?.toISOString() ?? null,
      dataSufficiency: { daysWithOrders: activeDays.length, windowDays: HISTORY_DAYS },
      policy: { name: policy.name, version: policy.version, learned: policy.table !== null },
    });
  });

  /** Historical demand, newest first, paginated; ranges are capped. */
  router.get('/demand', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const q = historyQuery.parse(req.query);
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.demandDaily.findMany({
      where: {
        outletId,
        ...(q.menuItemId ? { menuItemId: q.menuItemId } : {}),
        businessDate: { gte: asDate(q.from), lte: asDate(q.to) },
        ...(after
          ? {
              OR: [
                { businessDate: { lt: asDate(after.date) } },
                { businessDate: asDate(after.date), menuItemId: { gt: after.itemId } },
              ],
            }
          : {}),
      },
      orderBy: [{ businessDate: 'desc' }, { menuItemId: 'asc' }],
      take: q.limit + 1,
      include: { menuItem: { select: { name: true } } },
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    res.json({
      days: page.map((r) => ({
        date: dayOf(r.businessDate),
        menuItemId: r.menuItemId,
        name: r.menuItem.name,
        demand: demandOf(r),
        ordered: r.unitsOrdered,
        cancelled: r.unitsCancelled,
        rejected: r.unitsRejected,
        fulfilled: r.unitsFulfilled,
        noShow: r.unitsNoShow,
        open: r.unitsOpen,
        scheduled: r.unitsScheduled,
        immediate: r.unitsImmediate,
        replenished: r.unitsReplenished,
        wasted: r.unitsWasted,
        openingStock: r.openingStock,
        closingStock: r.closingStock,
        stockoutMinutes: r.stockoutMinutes,
        censored: r.censored,
        outletActive: r.outletActive,
      })),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor(dayOf(last.businessDate), last.menuItemId)
          : null,
    });
  });

  /** One item: daily history plus past forecasts (latest made before each day) vs actual. */
  router.get('/items/:itemId/history', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const itemId = idParam(req, 'itemId');
    const { days } = itemHistoryQuery.parse(req.query);
    const item = await db.menuItem.findFirst({
      where: { id: itemId, outletId },
      select: { id: true, name: true },
    });
    if (!item) throw notFound('Menu item not found');
    const today = todayIst();
    const from = addDays(today, -days);
    const [rows, forecasts] = await Promise.all([
      db.demandDaily.findMany({
        where: {
          outletId,
          menuItemId: itemId,
          businessDate: { gte: asDate(from), lt: asDate(today) },
        },
        orderBy: { businessDate: 'asc' },
      }),
      db.forecast.findMany({
        where: {
          outletId,
          menuItemId: itemId,
          targetDate: { gte: asDate(from), lt: asDate(today) },
        },
        orderBy: [{ targetDate: 'asc' }, { horizonDays: 'asc' }],
        select: { targetDate: true, quantity: true, horizonDays: true },
      }),
    ]);
    const forecastOf = new Map<string, number>();
    for (const f of forecasts) {
      const d = dayOf(f.targetDate);
      if (!forecastOf.has(d)) forecastOf.set(d, f.quantity); // shortest horizon first
    }
    res.json({
      item,
      days: rows.map((r) => ({
        date: dayOf(r.businessDate),
        demand: demandOf(r),
        fulfilled: r.unitsFulfilled,
        wasted: r.unitsWasted,
        closingStock: r.closingStock,
        censored: r.censored,
        outletActive: r.outletActive,
        forecast: forecastOf.get(dayOf(r.businessDate)) ?? null,
      })),
    });
  });

  router.get('/plans', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const { weekStart } = weekQuery.parse(req.query);
    res.json({ plans: await listPlans(db, outletId, weekStart) });
  });

  router.post('/plans', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const { weekStart } = generateBody.parse(req.body);
    const plan = await generatePlan(db, {
      outletId,
      weekStart,
      actor: await actorFor(req, outletId),
    });
    res.status(201).json({ plan });
  });

  router.get('/plans/:planId', async (req, res) => {
    res.json({ plan: await getPlan(db, idParam(req, 'outletId'), idParam(req, 'planId')) });
  });

  router.get('/plans/:planId/export.csv', async (req, res) => {
    const plan = await getPlan(db, idParam(req, 'outletId'), idParam(req, 'planId'));
    res
      .type('text/csv')
      .attachment(`stock-plan-${plan.weekStart}-v${plan.version}.csv`)
      .send(planCsv(plan));
  });

  router.patch('/plans/:planId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const { notes } = notesBody.parse(req.body);
    const plan = await updatePlanNotes(db, {
      outletId,
      planId: idParam(req, 'planId'),
      notes,
      actor: await actorFor(req, outletId),
    });
    res.json({ plan });
  });

  router.patch('/plans/:planId/items/:planItemId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = itemBody.parse(req.body);
    const plan = await updatePlanItem(db, {
      outletId,
      planId: idParam(req, 'planId'),
      planItemId: idParam(req, 'planItemId'),
      ...body,
      actor: await actorFor(req, outletId),
    });
    res.json({ plan });
  });

  for (const action of ['submit', 'approve', 'complete'] as const) {
    router.post(`/plans/:planId/${action}`, async (req, res) => {
      const outletId = idParam(req, 'outletId');
      const plan = await transitionPlan(db, {
        outletId,
        planId: idParam(req, 'planId'),
        action,
        actor: await actorFor(req, outletId),
      });
      res.json({ plan });
    });
  }

  /** Stock actually added for a plan line (a real restock, through the inventory ledger). */
  router.post('/plans/:planId/items/:planItemId/replenishments', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const idempotencyKey = requireIdempotencyKey(req);
    const { quantity } = replenishBody.parse(req.body);
    const result = await recordReplenishment(db, {
      outletId,
      planId: idParam(req, 'planId'),
      planItemId: idParam(req, 'planItemId'),
      quantity,
      idempotencyKey,
      actor: await actorFor(req, outletId),
    });
    if (result.created) realtime.stockChanged(outletId, [result.menuItemId]);
    res.status(result.created ? 201 : 200).json({ plan: result.plan });
  });

  /** How good the forecasts have been, and which stock policy is in use. */
  router.get('/evaluation', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const today = todayIst();
    const [runs, recent, latestPolicy, decisions, policy] = await Promise.all([
      db.forecastRun.findMany({
        where: { outletId, evaluatedAt: { not: null } },
        orderBy: { weekStart: 'desc' },
        take: 12,
        select: {
          id: true,
          weekStart: true,
          asOfDate: true,
          model: true,
          modelVersion: true,
          evaluation: true,
          trigger: true,
        },
      }),
      db.forecast.findMany({
        where: {
          outletId,
          evaluatedAt: { not: null },
          targetDate: { gte: asDate(addDays(today, -HISTORY_DAYS)) },
          horizonDays: { lte: 13 },
        },
        select: { quantity: true, actualDemand: true, actualCensored: true },
      }),
      db.policyVersion.findFirst({
        where: { name: POLICY_NAME },
        orderBy: { createdAt: 'desc' },
        select: { version: true, status: true, evaluation: true, createdAt: true },
      }),
      db.planningDecision.groupBy({ by: ['status'], where: { outletId }, _count: { _all: true } }),
      activePolicy(db),
    ]);
    res.json({
      forecastRuns: runs.map((r) => ({
        ...r,
        weekStart: dayOf(r.weekStart),
        asOfDate: dayOf(r.asOfDate),
      })),
      last8Weeks: metricsOf(recent),
      policy: {
        inUse: { name: policy.name, version: policy.version, learned: policy.table !== null },
        latestTrained: latestPolicy
          ? {
              version: latestPolicy.version,
              status: latestPolicy.status,
              verdict: (latestPolicy.evaluation as { verdict?: string }).verdict ?? null,
              createdAt: latestPolicy.createdAt.toISOString(),
            }
          : null,
        decisions: Object.fromEntries(decisions.map((d) => [d.status, d._count._all])),
      },
    });
  });

  return router;
}
