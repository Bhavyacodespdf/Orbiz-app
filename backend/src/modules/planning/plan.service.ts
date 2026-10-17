import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { PlanAction, StockPlanStatus } from '../../generated/prisma/enums.js';
import { Prisma } from '../../generated/prisma/client.js';
import { adjustStockTx } from '../inventory/inventory.service.js';
import { MAX_STOCK, stockStatus } from '../inventory/stock.js';
import { aggregateDemand, demandOf } from './demand.service.js';
import { generateForecastRun, type ItemFeatures } from './forecast.service.js';
import {
  addDays,
  asDate,
  dayOf,
  isMonday,
  nextMonday,
  todayIst,
  WEEKDAY_NAMES,
  weekdayOf,
} from './dates.js';
import { FALLBACK_SAFETY_FRACTION, MAX_WEEKS_AHEAD, SAFETY_Z } from './planning.rules.js';
import {
  activePolicy,
  candidatesFor,
  chooseAction,
  rewardOf,
  stateBucket,
  type Candidate,
  type DecisionState,
} from './policy.js';

/*
 * Weekly stock plans. A plan is a RECOMMENDATION for human review: nothing here changes live
 * stock except recordReplenishment, which goes through the inventory service (locked update +
 * ledger entry) exactly like a manual restock.
 */

export interface PlanActor {
  userId: string;
  role: 'MANAGER' | 'POS';
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const short = (day: string) => WEEKDAY_NAMES[weekdayOf(day)]!.slice(0, 3);

/** The planning week must be a future Monday, at most MAX_WEEKS_AHEAD weeks ahead. */
export function assertPlannableWeek(weekStart: string, now = new Date()) {
  const first = nextMonday(todayIst(now));
  const last = addDays(first, 7 * (MAX_WEEKS_AHEAD - 1));
  if (!isMonday(weekStart) || weekStart < first || weekStart > last) {
    throw new AppError(
      400,
      'INVALID_WEEK',
      `Choose a week starting on a Monday between ${first} and ${last}.`,
      { first, last },
    );
  }
}

interface DayForecastJson {
  date: string;
  quantity: number;
  lower: number;
  upper: number;
}

/** Pure: the recommendation for one item. Exported for tests. */
export function computeLine(input: {
  weekStart: string;
  forecasts: {
    date: string;
    quantity: number;
    lower: number;
    upper: number;
    sigma: number | null;
  }[];
  confidence: DecisionState['confidence'];
  features: ItemFeatures;
  tracked: boolean;
  currentStock: number | null;
  expectedIncoming: number;
  fulfillmentType: 'PACKAGED' | 'HANDMADE' | null;
}) {
  const week = input.forecasts.filter((f) => f.date >= input.weekStart);
  const gap = input.forecasts.filter((f) => f.date < input.weekStart);
  const forecastWeek = Math.round(week.reduce((a, f) => a + f.quantity, 0) * 100) / 100;
  // Independent days: variances add. Unknown σ on any day → fall back to a fraction.
  const sigmaWeek = week.every((f) => f.sigma !== null)
    ? Math.sqrt(week.reduce((a, f) => a + f.sigma! ** 2, 0))
    : null;
  const safetyStock =
    forecastWeek <= 0
      ? 0
      : sigmaWeek !== null
        ? Math.ceil(SAFETY_Z * sigmaWeek)
        : Math.ceil(FALLBACK_SAFETY_FRACTION * forecastWeek);
  // The safety buffer is added ONCE, to the week's total.
  const targetStock = Math.min(MAX_STOCK, Math.ceil(forecastWeek + safetyStock));
  const gapDemand = gap.reduce((a, f) => a + f.quantity, 0);
  // Stock now, minus what's expected to sell before the week starts.
  const projectedOpening =
    input.tracked && input.currentStock !== null
      ? Math.max(0, Math.round(input.currentStock - gapDemand))
      : null;
  const room = MAX_STOCK - (input.currentStock ?? 0);
  const baselineNeed = Math.max(
    0,
    Math.min(room, targetStock - (projectedOpening ?? 0) - input.expectedIncoming),
  );
  const state: DecisionState = {
    confidence: input.confidence,
    tracked: input.tracked,
    forecastWeek,
    sigmaWeek: sigmaWeek === null ? null : Math.round(sigmaWeek * 100) / 100,
    safetyStock,
    currentStock: input.currentStock,
    projectedOpening,
    baselineNeed,
    stockoutRate: input.features.stockoutRate,
    wastedLast28: input.features.wastedLast28,
    last7Demand: input.features.last7Demand,
    last28Demand: input.features.last28Demand,
    fulfillmentType: input.fulfillmentType,
  };
  return {
    week: week.map(({ date, quantity, lower, upper }) => ({ date, quantity, lower, upper })),
    gapDemand,
    forecastWeek,
    safetyStock,
    targetStock,
    projectedOpening,
    state,
    candidates: candidatesFor(baselineNeed, room),
  };
}

function explain(
  line: ReturnType<typeof computeLine>,
  f: ItemFeatures,
  chosen: { action: PlanAction; quantity: number; policy: string; bucket: string },
  weekStart: string,
  fulfillmentType: string | null,
): string[] {
  const out: string[] = [];
  out.push(
    `Forecast ${fmt(line.forecastWeek)} for the week (${line.week
      .map((d) => `${short(d.date)} ${fmt(d.quantity)}`)
      .join(' · ')}).`,
  );
  if (f.fallback === 'NONE') {
    out.push(
      `Based on ${f.usableDays} day${f.usableDays === 1 ? '' : 's'} of orders in the last 8 weeks, weighted towards recent days, with each weekday’s own pattern where there are at least 2 of it.`,
    );
  } else if (f.fallback === 'CENSORED_ONLY') {
    out.push(
      'The only history is from days it sold out, when sales understate demand — treat this as a minimum.',
    );
  } else if (f.fallback === 'CATEGORY_AVERAGE') {
    out.push('New item with no sales yet: uses the average of other items in its category.');
  } else {
    out.push(
      'No sales history for this item or its category yet — set a quantity from experience.',
    );
  }
  if (f.fallback === 'NONE' && f.censoredDays > 0) {
    out.push(
      `${f.censoredDays} sold-out day${f.censoredDays === 1 ? ' was' : 's were'} left out, because sales then understate demand.`,
    );
  }
  if (line.safetyStock > 0) {
    out.push(
      line.state.sigmaWeek !== null
        ? `Safety stock ${line.safetyStock}: covers about 90% of weeks, given demand varies by ±${fmt(line.state.sigmaWeek)} a week.`
        : `Safety stock ${line.safetyStock}: 20% of the forecast, because there’s too little history to measure how demand varies.`,
    );
  }
  if (line.projectedOpening !== null) {
    out.push(
      line.gapDemand > 0
        ? `${line.state.currentStock} in stock now; about ${fmt(line.gapDemand)} should sell before ${WEEKDAY_NAMES[weekdayOf(weekStart)]}, leaving ~${line.projectedOpening}.`
        : `${line.state.currentStock} in stock now.`,
    );
  } else {
    out.push(
      'Stock isn’t counted for this item, so the recommendation is the whole forecast plus safety stock: the amount to prepare or buy for the week.',
    );
  }
  out.push(
    chosen.quantity > 0
      ? line.projectedOpening === null
        ? `Prepare or buy ${chosen.quantity} over the week.`
        : `Recommend ${chosen.quantity} more to reach a target of ${line.targetStock}.`
      : line.targetStock === 0
        ? 'No demand expected: nothing to add.'
        : `Enough stock for the target of ${line.targetStock}: nothing to add.`,
  );
  if (chosen.policy !== 'baseline' && chosen.action !== 'MEDIUM' && chosen.action !== 'NONE') {
    out.push(
      `The learned policy chose a ${chosen.action.toLowerCase()} quantity for ${chosen.bucket} items.`,
    );
  }
  if (fulfillmentType === 'HANDMADE') {
    out.push('Handmade: prepare fresh each day using the daily figures rather than all at once.');
  }
  return out;
}

const planInclude = {
  forecastRun: true,
  createdBy: { select: { displayName: true } },
  submittedBy: { select: { displayName: true } },
  approvedBy: { select: { displayName: true } },
  completedBy: { select: { displayName: true } },
  items: {
    include: {
      menuItem: {
        select: {
          id: true,
          name: true,
          isActive: true,
          isAvailable: true,
          trackInventory: true,
          stockQuantity: true,
          lowStockThreshold: true,
          fulfillmentType: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  },
  revisions: {
    include: {
      actor: { select: { displayName: true } },
      planItem: { select: { menuItem: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
};

type PlanWithIncludes = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

async function loadPlan(db: DbClient, outletId: string, planId: string) {
  return db.stockPlan.findFirst({ where: { id: planId, outletId }, include: planInclude });
}

function itemStatus(
  plan: { status: StockPlanStatus },
  item: { finalQty: number; replenishedQty: number; tracked: boolean },
) {
  if (plan.status === 'DRAFT' || plan.status === 'SUBMITTED') return 'NEEDS_REVIEW';
  if (plan.status === 'SUPERSEDED') return 'SUPERSEDED';
  if (plan.status === 'COMPLETED') return 'COMPLETED';
  if (item.finalQty === 0) return 'NOTHING_TO_ADD';
  if (!item.tracked) return 'APPROVED';
  return item.replenishedQty >= item.finalQty ? 'REPLENISHED' : 'APPROVED';
}

export function toPlan(plan: PlanWithIncludes) {
  const items = [...plan.items].sort((a, b) =>
    a.menuItem.category.name === b.menuItem.category.name
      ? a.menuItem.name.localeCompare(b.menuItem.name)
      : a.menuItem.category.name.localeCompare(b.menuItem.category.name),
  );
  return {
    id: plan.id,
    outletId: plan.outletId,
    weekStart: dayOf(plan.weekStart),
    weekEnd: dayOf(plan.weekEnd),
    version: plan.version,
    status: plan.status,
    policy: { name: plan.policyName, version: plan.policyVersion },
    forecastRun: {
      id: plan.forecastRun.id,
      asOfDate: dayOf(plan.forecastRun.asOfDate),
      historyFrom: dayOf(plan.forecastRun.historyFrom),
      historyTo: dayOf(plan.forecastRun.historyTo),
      model: plan.forecastRun.model,
      modelVersion: plan.forecastRun.modelVersion,
      createdAt: plan.forecastRun.createdAt.toISOString(),
      evaluation: plan.forecastRun.evaluation,
    },
    totals: {
      forecastUnits: plan.totalForecastUnits,
      recommendedUnits: plan.totalRecommendedUnits,
      finalUnits: items.reduce((a, i) => a + i.finalQty, 0),
      replenishedUnits: items.reduce((a, i) => a + i.replenishedQty, 0),
      itemsNeedingReplenishment: items.filter((i) => i.recommendedQty > 0).length,
      overriddenItems: items.filter((i) => i.overridden).length,
      lowConfidenceItems: items.filter((i) => i.confidence === 'LOW' || i.confidence === 'NONE')
        .length,
      excessRiskItems: items.filter(
        (i) =>
          i.tracked &&
          i.currentStock !== null &&
          i.currentStock - i.targetStock >= Math.max(3, Math.ceil(0.5 * i.targetStock)),
      ).length,
    },
    notes: plan.notes,
    createdBy: plan.createdBy?.displayName ?? null,
    submittedBy: plan.submittedBy?.displayName ?? null,
    approvedBy: plan.approvedBy?.displayName ?? null,
    completedBy: plan.completedBy?.displayName ?? null,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    submittedAt: plan.submittedAt?.toISOString() ?? null,
    approvedAt: plan.approvedAt?.toISOString() ?? null,
    completedAt: plan.completedAt?.toISOString() ?? null,
    outcome: plan.outcome,
    items: items.map((i) => ({
      id: i.id,
      menuItem: {
        id: i.menuItem.id,
        name: i.menuItem.name,
        category: i.menuItem.category,
        fulfillmentType: i.menuItem.fulfillmentType,
        trackInventory: i.menuItem.trackInventory,
        stockQuantity: i.menuItem.stockQuantity,
        stockStatus: stockStatus(i.menuItem),
        isActive: i.menuItem.isActive,
      },
      dailyForecast: i.dailyForecast as unknown as DayForecastJson[],
      forecastUnits: i.forecastUnits,
      confidence: i.confidence,
      tracked: i.tracked,
      currentStock: i.currentStock,
      expectedIncoming: i.expectedIncoming,
      safetyStock: i.safetyStock,
      targetStock: i.targetStock,
      action: i.action,
      recommendedQty: i.recommendedQty,
      finalQty: i.finalQty,
      overridden: i.overridden,
      overrideReason: i.overrideReason,
      explanation: (i.explanation as { summary?: string[] }).summary ?? [],
      replenishedQty: i.replenishedQty,
      status: itemStatus(plan, i),
      // Counted stock well above the week's target: a wastage risk.
      excessRisk:
        i.tracked &&
        i.currentStock !== null &&
        i.currentStock - i.targetStock >= Math.max(3, Math.ceil(0.5 * i.targetStock)),
      outcome: i.outcome,
    })),
    revisions: plan.revisions.map((r) => ({
      id: r.id,
      kind: r.kind,
      itemName: r.planItem?.menuItem.name ?? null,
      fromQty: r.fromQty,
      toQty: r.toQty,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      reason: r.reason,
      actor: r.actor?.displayName ?? null,
      actorRole: r.actorRole,
      at: r.createdAt.toISOString(),
    })),
  };
}
export type PlanView = ReturnType<typeof toPlan>;

export async function getPlan(db: Database, outletId: string, planId: string) {
  const plan = await loadPlan(db, outletId, planId);
  if (!plan) throw notFound('Plan not found');
  return toPlan(plan);
}

/** Plans for the outlet (newest first), optionally for one week; includes superseded versions. */
export async function listPlans(db: Database, outletId: string, weekStart?: string) {
  const plans = await db.stockPlan.findMany({
    where: { outletId, ...(weekStart ? { weekStart: asDate(weekStart) } : {}) },
    orderBy: [{ weekStart: 'desc' }, { version: 'desc' }],
    take: 50,
    select: {
      id: true,
      weekStart: true,
      weekEnd: true,
      version: true,
      status: true,
      totalForecastUnits: true,
      totalRecommendedUnits: true,
      policyName: true,
      policyVersion: true,
      createdAt: true,
      approvedAt: true,
      completedAt: true,
    },
  });
  return plans.map((p) => ({
    ...p,
    weekStart: dayOf(p.weekStart),
    weekEnd: dayOf(p.weekEnd),
    createdAt: p.createdAt.toISOString(),
    approvedAt: p.approvedAt?.toISOString() ?? null,
    completedAt: p.completedAt?.toISOString() ?? null,
  }));
}

const lockWeek = (tx: DbClient, outletId: string, weekStart: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-plan:${outletId}:${weekStart}`}))`;

/**
 * Forecasts the week and builds a new plan version. A previous DRAFT/SUBMITTED version is kept
 * as SUPERSEDED history; an APPROVED or COMPLETED plan can't be regenerated.
 */
export async function generatePlan(
  db: Database,
  params: { outletId: string; weekStart: string; actor: PlanActor; now?: Date },
) {
  const now = params.now ?? new Date();
  const { outletId, weekStart, actor } = params;
  assertPlannableWeek(weekStart, now);
  const locked = await db.stockPlan.findFirst({
    where: { outletId, weekStart: asDate(weekStart), status: { in: ['APPROVED', 'COMPLETED'] } },
  });
  if (locked) throw planLocked();

  const run = await generateForecastRun(db, {
    outletId,
    weekStart,
    trigger: 'MANUAL',
    userId: actor.userId,
    now,
  });
  const [forecasts, items, policy] = await Promise.all([
    db.forecast.findMany({ where: { runId: run.id }, orderBy: { targetDate: 'asc' } }),
    db.menuItem.findMany({
      where: { outletId, isActive: true },
      select: { id: true, trackInventory: true, stockQuantity: true, fulfillmentType: true },
    }),
    activePolicy(db),
  ]);

  const lines = items.map((item) => {
    const fs = forecasts.filter((f) => f.menuItemId === item.id);
    const features = fs[0]!.features as unknown as ItemFeatures & { sigmaDay: number | null };
    const tracked = item.trackInventory && item.stockQuantity !== null;
    const line = computeLine({
      weekStart,
      forecasts: fs.map((f) => ({
        date: dayOf(f.targetDate),
        quantity: f.quantity,
        lower: f.lower,
        upper: f.upper,
        sigma: (f.features as { sigmaDay?: number | null }).sigmaDay ?? null,
      })),
      confidence: fs[0]!.confidence,
      features,
      tracked,
      currentStock: tracked ? item.stockQuantity : null,
      expectedIncoming: 0,
      fulfillmentType: item.fulfillmentType,
    });
    const action = chooseAction(policy, line.state);
    const quantity = line.candidates.find((c) => c.action === action)!.quantity;
    const bucket = stateBucket(line.state);
    return {
      item,
      line,
      action,
      quantity,
      confidence: fs[0]!.confidence,
      explanation: {
        summary: explain(
          line,
          features,
          { action, quantity, policy: policy.name, bucket },
          weekStart,
          item.fulfillmentType,
        ),
        state: line.state,
        candidates: line.candidates,
        bucket,
        features,
      },
    };
  });

  try {
    const planId = await db.$transaction(async (tx) => {
      await lockWeek(tx, outletId, weekStart);
      const live = await tx.stockPlan.findFirst({
        where: { outletId, weekStart: asDate(weekStart), status: { not: 'SUPERSEDED' } },
      });
      if (live && (live.status === 'APPROVED' || live.status === 'COMPLETED')) throw planLocked();
      const last = await tx.stockPlan.findFirst({
        where: { outletId, weekStart: asDate(weekStart) },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      if (live) {
        await tx.stockPlan.update({ where: { id: live.id }, data: { status: 'SUPERSEDED' } });
        await tx.stockPlanRevision.create({
          data: {
            planId: live.id,
            kind: 'STATUS',
            fromStatus: live.status,
            toStatus: 'SUPERSEDED',
            reason: 'Replaced by a newly generated version',
            actorUserId: actor.userId,
            actorRole: actor.role,
          },
        });
      }
      const plan = await tx.stockPlan.create({
        data: {
          outletId,
          weekStart: asDate(weekStart),
          weekEnd: asDate(addDays(weekStart, 6)),
          version: (last?.version ?? 0) + 1,
          forecastRunId: run.id,
          policyName: policy.name,
          policyVersion: policy.version,
          totalForecastUnits:
            Math.round(lines.reduce((a, l) => a + l.line.forecastWeek, 0) * 100) / 100,
          totalRecommendedUnits: lines.reduce((a, l) => a + l.quantity, 0),
          createdByUserId: actor.userId,
        },
      });
      await tx.stockPlanItem.createMany({
        data: lines.map((l) => ({
          planId: plan.id,
          outletId,
          menuItemId: l.item.id,
          dailyForecast: l.line.week,
          forecastUnits: l.line.forecastWeek,
          confidence: l.confidence,
          tracked: l.line.state.tracked,
          currentStock: l.line.state.currentStock,
          expectedIncoming: 0,
          safetyStock: l.line.safetyStock,
          targetStock: l.line.targetStock,
          action: l.action,
          recommendedQty: l.quantity,
          finalQty: l.quantity,
          explanation: JSON.parse(JSON.stringify(l.explanation)),
        })),
      });
      await tx.stockPlanRevision.create({
        data: {
          planId: plan.id,
          kind: 'CREATED',
          toStatus: 'DRAFT',
          reason: `Generated from forecast run ${run.id.slice(0, 8)} (${policy.name} ${policy.version})`,
          actorUserId: actor.userId,
          actorRole: actor.role,
        },
      });
      return plan.id;
    });
    return getPlan(db, outletId, planId);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(
        409,
        'PLAN_BEING_GENERATED',
        'Someone else just generated this plan. Reload to see it.',
      );
    }
    throw error;
  }
}

const planLocked = () =>
  new AppError(
    409,
    'PLAN_LOCKED',
    'This week’s plan is already approved. It can’t be regenerated; record what was actually restocked instead.',
  );

async function lockPlan(tx: DbClient, outletId: string, planId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "StockPlan" WHERE id = ${planId}::uuid AND "outletId" = ${outletId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound('Plan not found');
  return tx.stockPlan.findUniqueOrThrow({ where: { id: planId } });
}

/** Staff decide the quantity. A change from the recommendation needs a reason; every change is kept. */
export async function updatePlanItem(
  db: Database,
  params: {
    outletId: string;
    planId: string;
    planItemId: string;
    finalQty: number;
    reason?: string;
    actor: PlanActor;
  },
) {
  const { outletId, planId, planItemId, finalQty, actor } = params;
  const reason = params.reason?.trim() || null;
  await db.$transaction(async (tx) => {
    const plan = await lockPlan(tx, outletId, planId);
    if (plan.status !== 'DRAFT' && plan.status !== 'SUBMITTED') {
      throw new AppError(
        409,
        'PLAN_NOT_EDITABLE',
        'Only a draft or submitted plan can be changed.',
      );
    }
    const item = await tx.stockPlanItem.findFirst({ where: { id: planItemId, planId } });
    if (!item) throw notFound('Plan item not found');
    if (item.finalQty === finalQty && (reason === null || reason === item.overrideReason)) return;
    const overridden = finalQty !== item.recommendedQty;
    if (overridden && (!reason || reason.length < 3)) {
      throw new AppError(
        400,
        'OVERRIDE_REASON_REQUIRED',
        'Say why you’re changing the recommended quantity.',
      );
    }
    await tx.stockPlanItem.update({
      where: { id: item.id },
      data: { finalQty, overridden, overrideReason: overridden ? reason : null },
    });
    await tx.stockPlanRevision.create({
      data: {
        planId,
        planItemId: item.id,
        kind: overridden ? 'OVERRIDE' : 'RESET_TO_RECOMMENDATION',
        fromQty: item.finalQty,
        toQty: finalQty,
        reason,
        actorUserId: actor.userId,
        actorRole: actor.role,
      },
    });
  });
  return getPlan(db, outletId, planId);
}

export async function updatePlanNotes(
  db: Database,
  params: { outletId: string; planId: string; notes: string; actor: PlanActor },
) {
  await db.$transaction(async (tx) => {
    const plan = await lockPlan(tx, params.outletId, params.planId);
    if (plan.status === 'SUPERSEDED')
      throw new AppError(409, 'PLAN_NOT_EDITABLE', 'This version was replaced.');
    if (plan.notes === params.notes) return;
    await tx.stockPlan.update({ where: { id: plan.id }, data: { notes: params.notes } });
    await tx.stockPlanRevision.create({
      data: {
        planId: plan.id,
        kind: 'NOTES',
        reason: params.notes.slice(0, 500),
        actorUserId: params.actor.userId,
        actorRole: params.actor.role,
      },
    });
  });
  return getPlan(db, params.outletId, params.planId);
}

const TRANSITIONS: Record<
  'submit' | 'approve' | 'complete',
  { from: StockPlanStatus[]; to: StockPlanStatus; managerOnly: boolean }
> = {
  submit: { from: ['DRAFT'], to: 'SUBMITTED', managerOnly: false },
  approve: { from: ['DRAFT', 'SUBMITTED'], to: 'APPROVED', managerOnly: true },
  complete: { from: ['APPROVED'], to: 'COMPLETED', managerOnly: false },
};

/**
 * Status changes, each exactly once (row lock + status check). Approval freezes each line's
 * decision as reinforcement-learning experience: the state known now, and the action taken.
 */
export async function transitionPlan(
  db: Database,
  params: {
    outletId: string;
    planId: string;
    action: keyof typeof TRANSITIONS;
    actor: PlanActor;
    now?: Date;
  },
) {
  const now = params.now ?? new Date();
  const rule = TRANSITIONS[params.action];
  if (rule.managerOnly && params.actor.role !== 'MANAGER') {
    throw forbidden('Only the outlet’s manager can approve a stock plan.');
  }
  await db.$transaction(async (tx) => {
    const plan = await lockPlan(tx, params.outletId, params.planId);
    if (!rule.from.includes(plan.status)) {
      throw new AppError(
        409,
        'INVALID_PLAN_TRANSITION',
        `A ${plan.status.toLowerCase()} plan can’t be ${rule.to.toLowerCase()}.`,
        { status: plan.status },
      );
    }
    if (params.action === 'approve' && dayOf(plan.weekEnd) < todayIst(now)) {
      throw new AppError(409, 'PLAN_WEEK_OVER', 'This week is already over.');
    }
    const stamp =
      params.action === 'submit'
        ? { submittedByUserId: params.actor.userId, submittedAt: now }
        : params.action === 'approve'
          ? { approvedByUserId: params.actor.userId, approvedAt: now }
          : { completedByUserId: params.actor.userId, completedAt: now };
    await tx.stockPlan.update({ where: { id: plan.id }, data: { status: rule.to, ...stamp } });
    await tx.stockPlanRevision.create({
      data: {
        planId: plan.id,
        kind: 'STATUS',
        fromStatus: plan.status,
        toStatus: rule.to,
        actorUserId: params.actor.userId,
        actorRole: params.actor.role,
      },
    });
    if (params.action === 'approve') {
      const items = await tx.stockPlanItem.findMany({ where: { planId: plan.id } });
      await tx.planningDecision.createMany({
        data: items.map((i) => {
          const e = i.explanation as unknown as { state: DecisionState; candidates: Candidate[] };
          return {
            planItemId: i.id,
            outletId: i.outletId,
            menuItemId: i.menuItemId,
            periodStart: plan.weekStart,
            periodEnd: plan.weekEnd,
            decidedAt: now,
            policyName: plan.policyName,
            policyVersion: plan.policyVersion,
            // Only what was known when the plan was generated: no outcome data exists yet.
            state: JSON.parse(JSON.stringify(e.state)),
            candidateActions: JSON.parse(JSON.stringify(e.candidates)),
            action: i.action,
            recommendedQty: i.recommendedQty,
            approvedQty: i.finalQty,
          };
        }),
      });
      await recordAudit(tx, {
        actor: { type: 'USER', userId: params.actor.userId },
        action: 'STOCK_PLAN_APPROVED',
        entityType: 'StockPlan',
        entityId: plan.id,
        metadata: { weekStart: dayOf(plan.weekStart), version: plan.version, items: items.length },
      });
    }
  });
  return getPlan(db, params.outletId, params.planId);
}

/**
 * Records stock actually added for a plan line: a normal RESTOCK through the inventory service
 * (conditional update + ledger row in one transaction), linked to the line. The client's
 * Idempotency-Key makes retries safe: a key already used returns the plan unchanged.
 */
export async function recordReplenishment(
  db: Database,
  params: {
    outletId: string;
    planId: string;
    planItemId: string;
    quantity: number;
    idempotencyKey: string;
    actor: PlanActor;
  },
) {
  const { outletId, planId, planItemId, quantity, actor } = params;
  const key = `plan:${planItemId}:${params.idempotencyKey}`;
  const already = await db.stockAdjustment.findUnique({ where: { idempotencyKey: key } });
  if (already)
    return {
      plan: await getPlan(db, outletId, planId),
      menuItemId: already.menuItemId,
      created: false,
    };
  try {
    const menuItemId = await db.$transaction(async (tx) => {
      const plan = await lockPlan(tx, outletId, planId);
      if (plan.status !== 'APPROVED') {
        throw new AppError(
          409,
          'PLAN_NOT_APPROVED',
          'Restocks can be recorded against an approved plan only.',
        );
      }
      const item = await tx.stockPlanItem.findFirst({ where: { id: planItemId, planId } });
      if (!item) throw notFound('Plan item not found');
      await adjustStockTx(tx, {
        outletId,
        itemId: item.menuItemId,
        input: { type: 'RESTOCK', quantity, reason: `Weekly stock plan ${dayOf(plan.weekStart)}` },
        actor,
        planLink: { planItemId: item.id, idempotencyKey: key },
      });
      await tx.stockPlanItem.update({
        where: { id: item.id },
        data: { replenishedQty: { increment: quantity } },
      });
      await tx.stockPlanRevision.create({
        data: {
          planId,
          planItemId: item.id,
          kind: 'REPLENISHED',
          fromQty: item.replenishedQty,
          toQty: item.replenishedQty + quantity,
          actorUserId: actor.userId,
          actorRole: actor.role,
        },
      });
      return item.menuItemId;
    });
    return { plan: await getPlan(db, outletId, planId), menuItemId, created: true };
  } catch (error) {
    // The same key at the same moment: the other request recorded it.
    if (isUniqueViolation(error)) {
      const winner = await db.stockAdjustment.findUnique({ where: { idempotencyKey: key } });
      if (winner)
        return {
          plan: await getPlan(db, outletId, planId),
          menuItemId: winner.menuItemId,
          created: false,
        };
    }
    throw error;
  }
}

/**
 * After a plan's week ends: actual demand, sales, stockouts, wastage and leftover per line, and
 * the reward for each approved decision. Only ever fills in PENDING decisions and plans without
 * an outcome, so it is safe to run repeatedly or from several workers.
 */
export async function finalizeOutcomes(db: Database, now = new Date()) {
  const today = todayIst(now);
  const plans = await db.stockPlan.findMany({
    where: {
      status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED', 'COMPLETED'] },
      outcome: { equals: Prisma.DbNull },
      weekEnd: { lt: asDate(today) },
    },
    include: { items: { include: { decision: true } } },
    take: 50,
  });
  let finalized = 0;
  for (const plan of plans) {
    const from = dayOf(plan.weekStart);
    const to = dayOf(plan.weekEnd);
    await aggregateDemand(db, { from, to, outletId: plan.outletId, now });
    const rows = await db.demandDaily.findMany({
      where: { outletId: plan.outletId, businessDate: { gte: plan.weekStart, lte: plan.weekEnd } },
      orderBy: { businessDate: 'asc' },
    });
    const summary = {
      demandUnits: 0,
      fulfilledUnits: 0,
      wastedUnits: 0,
      stockoutDays: 0,
      forecastUnits: 0,
      absError: 0,
    };
    for (const item of plan.items) {
      const days = rows.filter((r) => r.menuItemId === item.menuItemId);
      const forecast = item.dailyForecast as unknown as DayForecastJson[];
      const daily = forecast.map((f) => {
        const r = days.find((d) => dayOf(d.businessDate) === f.date);
        return {
          date: f.date,
          forecast: f.quantity,
          actual: r ? demandOf(r) : 0,
          fulfilled: r?.unitsFulfilled ?? 0,
          rejected: r?.unitsRejected ?? 0,
          wasted: r?.unitsWasted ?? 0,
          censored: r?.censored ?? false,
          closingStock: r?.closingStock ?? null,
        };
      });
      const demand = daily.reduce((a, d) => a + d.actual, 0);
      const fulfilled = daily.reduce((a, d) => a + d.fulfilled, 0);
      const wasted = daily.reduce((a, d) => a + d.wasted, 0);
      const stockoutDays = daily.filter((d) => d.censored).length;
      // Unmet demand: units the outlet refused, plus — on sold-out days — the forecast shortfall
      // (an ESTIMATE: true demand on those days wasn't observable).
      const estimatedLost =
        daily.reduce((a, d) => a + d.rejected, 0) +
        Math.round(
          daily
            .filter((d) => d.censored)
            .reduce((a, d) => a + Math.max(0, d.forecast - d.actual), 0),
        );
      const leftover = item.tracked ? (daily.at(-1)?.closingStock ?? null) : null;
      const replenished = await db.stockAdjustment.aggregate({
        where: { planItemId: item.id },
        _sum: { quantityChange: true },
      });
      const outcome = {
        daily,
        demandUnits: demand,
        fulfilledUnits: fulfilled,
        wastedUnits: wasted,
        stockoutDays,
        estimatedLostUnits: estimatedLost,
        leftoverUnits: leftover,
        replenishedUnits: replenished._sum.quantityChange ?? 0,
        forecastUnits: item.forecastUnits,
        absError: Math.round(Math.abs(item.forecastUnits - demand) * 100) / 100,
      };
      await db.stockPlanItem.update({ where: { id: item.id }, data: { outcome } });
      summary.demandUnits += demand;
      summary.fulfilledUnits += fulfilled;
      summary.wastedUnits += wasted;
      summary.stockoutDays += stockoutDays;
      summary.forecastUnits += item.forecastUnits;
      summary.absError += outcome.absError;

      if (item.decision && item.decision.status === 'PENDING') {
        const { reward, components } = rewardOf({ fulfilled, estimatedLost, wasted, leftover });
        const excluded = !item.tracked ? 'STOCK_NOT_COUNTED' : null;
        await db.planningDecision.updateMany({
          where: { id: item.decision.id, status: 'PENDING' },
          data: {
            replenishedQty: outcome.replenishedUnits,
            demandUnits: demand,
            fulfilledUnits: fulfilled,
            stockoutDays,
            estimatedLostUnits: estimatedLost,
            wastedUnits: wasted,
            leftoverUnits: leftover,
            censored: stockoutDays > 0,
            rewardComponents: excluded ? undefined : components,
            reward: excluded ? null : reward,
            status: excluded ? 'EXCLUDED' : 'FINALIZED',
            excludeReason: excluded,
            finalizedAt: now,
          },
        });
      }
    }
    const { count } = await db.stockPlan.updateMany({
      where: { id: plan.id, outcome: { equals: Prisma.DbNull } },
      data: {
        outcome: {
          ...summary,
          forecastUnits: Math.round(summary.forecastUnits * 100) / 100,
          absError: Math.round(summary.absError * 100) / 100,
          wape:
            summary.demandUnits > 0
              ? Math.round((summary.absError / summary.demandUnits) * 100) / 100
              : null,
          finalizedAt: now.toISOString(),
        },
      },
    });
    finalized += count;
  }
  return finalized;
}

/** CSV of a plan (opens in any spreadsheet). */
export function planCsv(plan: PlanView): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Quote, and neutralise spreadsheet formulas.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = [
    'Item',
    'Category',
    'Current stock',
    'Forecast (week)',
    'Confidence',
    'Safety stock',
    'Target stock',
    'Recommended',
    'Final',
    'Overridden',
    'Override reason',
    'Replenished',
    'Status',
    ...(plan.items[0]?.dailyForecast.map((d) => `Forecast ${d.date}`) ?? []),
  ];
  const rows = plan.items.map((i) => [
    i.menuItem.name,
    i.menuItem.category.name,
    i.tracked ? i.currentStock : 'not counted',
    i.forecastUnits,
    i.confidence,
    i.safetyStock,
    i.targetStock,
    i.recommendedQty,
    i.finalQty,
    i.overridden ? 'yes' : 'no',
    i.overrideReason,
    i.replenishedQty,
    i.status,
    ...i.dailyForecast.map((d) => d.quantity),
  ]);
  const meta = [
    `Weekly stock plan ${plan.weekStart} to ${plan.weekEnd} (v${plan.version}, ${plan.status}). Forecasts are estimates, not guaranteed sales.`,
  ];
  return [meta, header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
