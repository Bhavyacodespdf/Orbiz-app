import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { outletRow } from '@/test/staff';
import type { Plan, PlanItem, PlanStatus } from '@/services/planning';

afterEach(() => {
  vi.unstubAllGlobals();
});

const week = [
  '2026-10-26',
  '2026-10-27',
  '2026-10-28',
  '2026-10-29',
  '2026-10-30',
  '2026-10-31',
  '2026-11-01',
];

function planItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'pi1',
    menuItem: {
      id: 'm1',
      name: 'Veg puff',
      category: { id: 'c1', name: 'Snacks' },
      fulfillmentType: 'PACKAGED',
      trackInventory: true,
      stockQuantity: 18,
      stockStatus: 'AVAILABLE',
      isActive: true,
    },
    dailyForecast: week.map((date) => ({ date, quantity: 5, lower: 3, upper: 7 })),
    forecastUnits: 35,
    confidence: 'HIGH',
    tracked: true,
    currentStock: 18,
    expectedIncoming: 0,
    safetyStock: 7,
    targetStock: 42,
    action: 'MEDIUM',
    recommendedQty: 24,
    finalQty: 24,
    overridden: false,
    overrideReason: null,
    explanation: [
      'Forecast 35 for the week (Mon 5 · Tue 5).',
      'Recommend 24 more to reach a target of 42.',
    ],
    replenishedQty: 0,
    status: 'NEEDS_REVIEW',
    excessRisk: false,
    outcome: null,
    ...overrides,
  };
}

function plan(status: PlanStatus = 'DRAFT', items: PlanItem[] = [planItem()]): Plan {
  return {
    id: 'p1',
    weekStart: '2026-10-26',
    weekEnd: '2026-11-01',
    version: 1,
    status,
    policy: { name: 'baseline', version: '1.0.0' },
    forecastRun: {
      id: 'r1',
      asOfDate: '2026-10-17',
      historyFrom: '2026-08-22',
      historyTo: '2026-10-16',
      model: 'weekday-ewma-baseline',
      modelVersion: '1.0.0',
      createdAt: '2026-10-17T05:00:00.000Z',
      evaluation: null,
    },
    totals: {
      forecastUnits: 35,
      recommendedUnits: 24,
      finalUnits: 24,
      replenishedUnits: 0,
      itemsNeedingReplenishment: 1,
      overriddenItems: 0,
      lowConfidenceItems: 0,
      excessRiskItems: 0,
    },
    notes: '',
    createdBy: 'Asha',
    submittedBy: null,
    approvedBy: null,
    completedBy: null,
    createdAt: '2026-10-17T05:00:00.000Z',
    submittedAt: null,
    approvedAt: null,
    completedAt: null,
    outcome: null,
    items: items.map((i) => ({
      ...i,
      status: status === 'APPROVED' ? 'APPROVED' : status === 'COMPLETED' ? 'COMPLETED' : i.status,
    })),
    revisions: [],
  };
}

const overview = (role: 'MANAGER' | 'POS', p: Plan | null, daysWithOrders = 40) => ({
  week: {
    start: '2026-10-26',
    end: '2026-11-01',
    firstPlannable: '2026-10-26',
    lastPlannable: '2026-11-16',
  },
  role,
  plan: p,
  stock: { AVAILABLE: 4, LOW_STOCK: 1, SOLD_OUT: 2 },
  latestForecast: p
    ? { id: 'r1', createdAt: '2026-10-17T05:00:00.000Z', asOfDate: '2026-10-17', trigger: 'MANUAL' }
    : null,
  demandUpdatedAt: '2026-10-17T05:00:00.000Z',
  dataSufficiency: { daysWithOrders, windowDays: 56 },
  policy: { name: 'baseline', version: '1.0.0', learned: false },
});

type Handler = Parameters<typeof mockApi>[0][string];

function setup(
  role: 'MANAGER' | 'POS',
  p: Plan | null,
  extra: Record<string, Handler> = {},
  daysWithOrders = 40,
) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', role] })),
    'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow([role])] } }),
    'GET /staff/outlets/o1/planning/overview': () => ({
      status: 200,
      body: overview(role, p, daysWithOrders),
    }),
    'GET /staff/outlets/o1/planning/items/m1/history': () => ({
      status: 200,
      body: {
        item: { id: 'm1', name: 'Veg puff' },
        days: [
          {
            date: '2026-10-15',
            demand: 6,
            fulfilled: 6,
            wasted: 0,
            closingStock: 12,
            censored: false,
            outletActive: true,
            forecast: 5,
          },
          {
            date: '2026-10-16',
            demand: 2,
            fulfilled: 2,
            wasted: 0,
            closingStock: 0,
            censored: true,
            outletActive: true,
            forecast: 5,
          },
        ],
      },
    }),
    ...extra,
  });
}

const calls = (fetchMock: ReturnType<typeof setup>, path: string, method: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === `/api/v1${path}` && init?.method === method,
  );

describe('Weekly Stock Planner', () => {
  it('generates a plan when there is none, and says forecasts are estimates', async () => {
    const fetchMock = setup(
      'POS',
      null,
      {
        'POST /staff/outlets/o1/planning/plans': () => ({ status: 201, body: { plan: plan() } }),
      },
      5,
    );
    renderRoute('/pos/planner');
    expect(
      await screen.findByRole('heading', { name: 'Weekly Stock Planner' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Forecasts are estimates, not guaranteed sales/)).toBeInTheDocument();
    expect(await screen.findByText('No plan for this week yet')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Only 5 days with orders/);
    await userEvent.click(screen.getByRole('button', { name: 'Generate forecast and plan' }));
    await waitFor(() =>
      expect(
        calls(fetchMock, '/staff/outlets/o1/planning/plans', 'POST').map(([, i]) =>
          JSON.parse(String(i!.body)),
        ),
      ).toEqual([{ weekStart: '2026-10-26' }]),
    );
  });

  it('shows each item’s numbers and explains the recommendation, including sold-out days', async () => {
    setup('POS', plan());
    renderRoute('/pos/planner');
    const row = (await screen.findByRole('button', { name: /^Veg puff/ })).closest('tr')!;
    for (const value of ['18', '35', '7', '24'])
      expect(within(row).getAllByText(value).length).toBeGreaterThan(0);
    expect(within(row).getByText('High confidence')).toBeInTheDocument();
    expect(within(row).getByText('Needs review')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /^Veg puff/ }));
    expect(
      await screen.findByText('Recommend 24 more to reach a target of 42.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Daily forecast for Veg puff' }).children).toHaveLength(
      7,
    );
    expect(
      await screen.findByRole('img', { name: /Daily demand for Veg puff/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/sold out part of the day/)).toBeInTheDocument();
  });

  it('needs a reason to change a recommendation, and POS staff can submit but not approve', async () => {
    const fetchMock = setup('POS', plan(), {
      'PATCH /staff/outlets/o1/planning/plans/p1/items/pi1': () => ({
        status: 200,
        body: {
          plan: plan('DRAFT', [
            planItem({ finalQty: 10, overridden: true, overrideReason: 'Exams' }),
          ]),
        },
      }),
      'POST /staff/outlets/o1/planning/plans/p1/submit': () => ({
        status: 200,
        body: { plan: plan('SUBMITTED') },
      }),
    });
    renderRoute('/pos/planner');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change quantity for Veg puff' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Quantity for Veg puff' });
    const qty = within(dialog).getByLabelText('Final quantity');
    await userEvent.clear(qty);
    await userEvent.type(qty, '10');
    const save = within(dialog).getByRole('button', { name: 'Save quantity' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason for the change/), 'Exams');
    await userEvent.click(save);
    await waitFor(() =>
      expect(
        calls(fetchMock, '/staff/outlets/o1/planning/plans/p1/items/pi1', 'PATCH').map(([, i]) =>
          JSON.parse(String(i!.body)),
        ),
      ).toEqual([{ finalQty: 10, reason: 'Exams' }]),
    );
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() =>
      expect(calls(fetchMock, '/staff/outlets/o1/planning/plans/p1/submit', 'POST')).toHaveLength(
        1,
      ),
    );
  });

  it('lets the manager approve', async () => {
    const fetchMock = setup('MANAGER', plan('SUBMITTED'), {
      'POST /staff/outlets/o1/planning/plans/p1/approve': () => ({
        status: 200,
        body: { plan: plan('APPROVED') },
      }),
    });
    renderRoute('/manage/planner');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve plan' }));
    await waitFor(() =>
      expect(calls(fetchMock, '/staff/outlets/o1/planning/plans/p1/approve', 'POST')).toHaveLength(
        1,
      ),
    );
    expect(screen.queryByRole('button', { name: /Refresh forecast/ })).toBeInTheDocument();
  });

  it('records a real restock against an approved plan with a retry-safe key', async () => {
    const fetchMock = setup('POS', plan('APPROVED'), {
      'POST /staff/outlets/o1/planning/plans/p1/items/pi1/replenishments': () => ({
        status: 201,
        body: { plan: plan('APPROVED', [planItem({ replenishedQty: 24 })]) },
      }),
    });
    renderRoute('/pos/planner');
    expect(screen.queryByRole('button', { name: /Refresh forecast/ })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: /^Veg puff/ }));
    const field = await screen.findByLabelText('Units actually added for Veg puff');
    expect(field).toHaveValue('24');
    await userEvent.click(screen.getByRole('button', { name: 'Record restock' }));
    expect(await screen.findByText('Recorded 24 added to stock.')).toBeInTheDocument();
    const init = calls(
      fetchMock,
      '/staff/outlets/o1/planning/plans/p1/items/pi1/replenishments',
      'POST',
    )[0]?.[1];
    expect(JSON.parse(String(init!.body))).toEqual({ quantity: 24 });
    expect(new Headers(init!.headers).get('Idempotency-Key')).toMatch(/^cc-/);
  });

  it('compares forecast with actual once the week is over', async () => {
    const outcome = {
      daily: week.map((date, i) => ({
        date,
        forecast: 5,
        actual: i === 4 ? 9 : 5,
        fulfilled: 5,
        wasted: 0,
        censored: i === 4,
        closingStock: 3,
      })),
      demandUnits: 39,
      fulfilledUnits: 35,
      wastedUnits: 0,
      stockoutDays: 1,
      estimatedLostUnits: 4,
      leftoverUnits: 3,
      replenishedUnits: 24,
      forecastUnits: 35,
      absError: 4,
    };
    const done = {
      ...plan('COMPLETED', [planItem({ outcome })]),
      outcome: {
        demandUnits: 39,
        fulfilledUnits: 35,
        wastedUnits: 0,
        stockoutDays: 1,
        forecastUnits: 35,
        absError: 4,
        wape: 0.1,
      },
    };
    setup('POS', done);
    renderRoute('/pos/planner');
    expect((await screen.findByText(/Week finished:/)).closest('p')).toHaveTextContent(
      'actual demand 39 (10% off overall)',
    );
    await userEvent.click(screen.getByRole('button', { name: /^Veg puff/ }));
    expect(await screen.findByText(/forecast 35, actual 39 \(off by 4\)/)).toBeInTheDocument();
    expect(screen.getAllByText('Sold out').length).toBeGreaterThan(0);
  });
});
