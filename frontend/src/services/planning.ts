import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { API_BASE, apiFetch } from './http';
import { stockStatusSchema } from './outlets';

/*
 * Weekly Stock Planner. Every figure comes from the server: forecasts, recommendations and
 * outcomes are calculated there from real orders and the stock ledger. The browser only sends
 * a human decision (a quantity and a reason) or an action (submit, approve, restock).
 */

export const planningKey = (outletId: string) => ['staff', 'planning', outletId] as const;
const base = (outletId: string) => `/staff/outlets/${outletId}/planning`;

const confidenceSchema = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']);
export type Confidence = z.infer<typeof confidenceSchema>;
export const planStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'COMPLETED',
  'SUPERSEDED',
]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

const dayForecastSchema = z.object({
  date: z.string(),
  quantity: z.number(),
  lower: z.number(),
  upper: z.number(),
});

const itemOutcomeSchema = z
  .object({
    daily: z.array(
      z.object({
        date: z.string(),
        forecast: z.number(),
        actual: z.number().int(),
        fulfilled: z.number().int(),
        wasted: z.number().int(),
        censored: z.boolean(),
        closingStock: z.number().int().nullable(),
      }),
    ),
    demandUnits: z.number().int(),
    fulfilledUnits: z.number().int(),
    wastedUnits: z.number().int(),
    stockoutDays: z.number().int(),
    estimatedLostUnits: z.number().int(),
    leftoverUnits: z.number().int().nullable(),
    replenishedUnits: z.number().int(),
    forecastUnits: z.number(),
    absError: z.number(),
  })
  .nullable();

export const planItemSchema = z.object({
  id: z.string(),
  menuItem: z.object({
    id: z.string(),
    name: z.string(),
    category: z.object({ id: z.string(), name: z.string() }),
    fulfillmentType: z.enum(['PACKAGED', 'HANDMADE']).nullable(),
    trackInventory: z.boolean(),
    stockQuantity: z.number().int().nullable(),
    stockStatus: stockStatusSchema,
    isActive: z.boolean(),
  }),
  dailyForecast: z.array(dayForecastSchema),
  forecastUnits: z.number(),
  confidence: confidenceSchema,
  tracked: z.boolean(),
  currentStock: z.number().int().nullable(),
  expectedIncoming: z.number().int(),
  safetyStock: z.number().int(),
  targetStock: z.number().int(),
  action: z.enum(['NONE', 'SMALL', 'MEDIUM', 'LARGE']),
  recommendedQty: z.number().int(),
  finalQty: z.number().int(),
  overridden: z.boolean(),
  overrideReason: z.string().nullable(),
  explanation: z.array(z.string()),
  replenishedQty: z.number().int(),
  status: z.enum([
    'NEEDS_REVIEW',
    'APPROVED',
    'REPLENISHED',
    'NOTHING_TO_ADD',
    'COMPLETED',
    'SUPERSEDED',
  ]),
  excessRisk: z.boolean(),
  outcome: itemOutcomeSchema,
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const planSchema = z.object({
  id: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  version: z.number().int(),
  status: planStatusSchema,
  policy: z.object({ name: z.string(), version: z.string() }),
  forecastRun: z.object({
    id: z.string(),
    asOfDate: z.string(),
    historyFrom: z.string(),
    historyTo: z.string(),
    model: z.string(),
    modelVersion: z.string(),
    createdAt: z.string(),
    evaluation: z.unknown().nullable(),
  }),
  totals: z.object({
    forecastUnits: z.number(),
    recommendedUnits: z.number().int(),
    finalUnits: z.number().int(),
    replenishedUnits: z.number().int(),
    itemsNeedingReplenishment: z.number().int(),
    overriddenItems: z.number().int(),
    lowConfidenceItems: z.number().int(),
    excessRiskItems: z.number().int(),
  }),
  notes: z.string(),
  createdBy: z.string().nullable(),
  submittedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  completedBy: z.string().nullable(),
  createdAt: z.string(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  outcome: z
    .object({
      demandUnits: z.number(),
      fulfilledUnits: z.number(),
      wastedUnits: z.number(),
      stockoutDays: z.number(),
      forecastUnits: z.number(),
      absError: z.number(),
      wape: z.number().nullable(),
    })
    .passthrough()
    .nullable(),
  items: z.array(planItemSchema),
  revisions: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      itemName: z.string().nullable(),
      fromQty: z.number().int().nullable(),
      toQty: z.number().int().nullable(),
      fromStatus: planStatusSchema.nullable(),
      toStatus: planStatusSchema.nullable(),
      reason: z.string().nullable(),
      actor: z.string().nullable(),
      actorRole: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export type Plan = z.infer<typeof planSchema>;

const overviewSchema = z.object({
  week: z.object({
    start: z.string(),
    end: z.string(),
    firstPlannable: z.string(),
    lastPlannable: z.string(),
  }),
  role: z.enum(['MANAGER', 'POS']),
  plan: planSchema.nullable(),
  stock: z.object({ AVAILABLE: z.number(), LOW_STOCK: z.number(), SOLD_OUT: z.number() }),
  latestForecast: z
    .object({ id: z.string(), createdAt: z.string(), asOfDate: z.string(), trigger: z.string() })
    .passthrough()
    .nullable(),
  demandUpdatedAt: z.string().nullable(),
  dataSufficiency: z.object({ daysWithOrders: z.number().int(), windowDays: z.number().int() }),
  policy: z.object({ name: z.string(), version: z.string(), learned: z.boolean() }),
});
export type PlannerOverview = z.infer<typeof overviewSchema>;

const itemHistorySchema = z.object({
  item: z.object({ id: z.string(), name: z.string() }),
  days: z.array(
    z.object({
      date: z.string(),
      demand: z.number().int(),
      fulfilled: z.number().int(),
      wasted: z.number().int(),
      closingStock: z.number().int().nullable(),
      censored: z.boolean(),
      outletActive: z.boolean(),
      forecast: z.number().nullable(),
    }),
  ),
});
export type ItemHistory = z.infer<typeof itemHistorySchema>;

const metricsSchema = z.object({
  evaluatedForecasts: z.number(),
  excludedForecasts: z.number(),
  totalActual: z.number(),
  totalForecast: z.number(),
  mae: z.number().nullable(),
  wape: z.number().nullable(),
  bias: z.number().nullable(),
});

const evaluationSchema = z.object({
  last8Weeks: metricsSchema,
  forecastRuns: z.array(
    z
      .object({ id: z.string(), weekStart: z.string(), evaluation: metricsSchema.nullable() })
      .passthrough(),
  ),
  policy: z.object({
    inUse: z.object({ name: z.string(), version: z.string(), learned: z.boolean() }),
    latestTrained: z
      .object({ version: z.string(), status: z.string(), verdict: z.string().nullable() })
      .passthrough()
      .nullable(),
    decisions: z.record(z.string(), z.number()),
  }),
});
export type PlanningEvaluation = z.infer<typeof evaluationSchema>;

export function usePlannerOverview(outletId: string, weekStart: string | null) {
  return useQuery({
    queryKey: [...planningKey(outletId), 'overview', weekStart],
    queryFn: async () =>
      overviewSchema.parse(
        await apiFetch(`${base(outletId)}/overview${weekStart ? `?weekStart=${weekStart}` : ''}`),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useItemHistory(outletId: string, menuItemId: string | null) {
  return useQuery({
    queryKey: [...planningKey(outletId), 'item-history', menuItemId],
    queryFn: async () =>
      itemHistorySchema.parse(await apiFetch(`${base(outletId)}/items/${menuItemId}/history`)),
    enabled: Boolean(menuItemId),
  });
}

export function usePlanningEvaluation(outletId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...planningKey(outletId), 'evaluation'],
    queryFn: async () => evaluationSchema.parse(await apiFetch(`${base(outletId)}/evaluation`)),
    enabled,
  });
}

/** Plan-changing actions; each answer is the server's updated plan. */
function usePlanMutation<T>(outletId: string, request: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => z.object({ plan: planSchema }).parse(await request(input)).plan,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: planningKey(outletId) });
      void queryClient.invalidateQueries({ queryKey: ['staff', 'inventory', outletId] });
    },
  });
}

export function useGeneratePlan(outletId: string) {
  return usePlanMutation(outletId, (weekStart: string) =>
    apiFetch(`${base(outletId)}/plans`, { method: 'POST', body: JSON.stringify({ weekStart }) }),
  );
}

export function useUpdatePlanItem(outletId: string, planId: string) {
  return usePlanMutation(
    outletId,
    ({ planItemId, ...body }: { planItemId: string; finalQty: number; reason?: string }) =>
      apiFetch(`${base(outletId)}/plans/${planId}/items/${planItemId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  );
}

export function useUpdatePlanNotes(outletId: string, planId: string) {
  return usePlanMutation(outletId, (notes: string) =>
    apiFetch(`${base(outletId)}/plans/${planId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }),
  );
}

export function usePlanTransition(outletId: string, planId: string) {
  return usePlanMutation(outletId, (action: 'submit' | 'approve' | 'complete') =>
    apiFetch(`${base(outletId)}/plans/${planId}/${action}`, { method: 'POST' }),
  );
}

export function useRecordReplenishment(outletId: string, planId: string) {
  return usePlanMutation(
    outletId,
    ({
      planItemId,
      quantity,
      idempotencyKey,
    }: {
      planItemId: string;
      quantity: number;
      idempotencyKey: string;
    }) =>
      apiFetch(`${base(outletId)}/plans/${planId}/items/${planItemId}/replenishments`, {
        method: 'POST',
        body: JSON.stringify({ quantity }),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
  );
}

/** A link the browser downloads directly (same-origin session cookie; a GET needs no CSRF header). */
export const planExportUrl = (outletId: string, planId: string) =>
  `${API_BASE}${base(outletId)}/plans/${planId}/export.csv`;
