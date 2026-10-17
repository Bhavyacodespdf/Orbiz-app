import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart, makeOrder } from '@/test/commerce';
import { outletRow } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

function trackingApi(tracking: object, status = 'ACCEPTED') {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser()),
    'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
    'GET /orders/ord1': () => ({
      status: 200,
      body: { order: makeOrder({ status: status as never }) },
    }),
    'GET /orders/ord1/pickup': () => ({ status: 200, body: { pickup: { state: 'NOT_READY' } } }),
    'GET /orders/ord1/tracking': () => ({
      status: 200,
      body: {
        tracking: {
          orderId: 'ord1',
          status,
          timeline: [],
          readyAt: null,
          collectedAt: null,
          estimate: null,
          ...tracking,
        },
      },
    }),
  });
}

describe('order tracking estimate', () => {
  it('shows orders ahead and an approximate ready time', async () => {
    trackingApi({
      estimate: {
        queuePosition: 3,
        ordersAhead: 2,
        predictedReadyAt: new Date(Date.now() + 12 * 60_000).toISOString(),
        rangeMinutes: null,
        awaitingAcceptance: false,
        updatedAt: new Date().toISOString(),
      },
    });
    renderRoute('/orders/ord1');
    expect(await screen.findByText('2 orders ahead of yours')).toBeVisible();
    expect(screen.getByText(/Estimated ready around .* \(approximate\)/)).toBeVisible();
  });

  it('shows a ± range only when the server provides one, and the real ready time once ready', async () => {
    trackingApi({
      estimate: {
        queuePosition: 0,
        ordersAhead: 0,
        predictedReadyAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        rangeMinutes: 2,
        awaitingAcceptance: false,
        updatedAt: new Date().toISOString(),
      },
    });
    const { unmount } = renderRoute('/orders/ord1');
    expect(await screen.findByText('Being prepared now')).toBeVisible();
    expect(screen.getByText(/\(± 2 min\)/)).toBeVisible();
    unmount();
    vi.unstubAllGlobals();
    trackingApi({ readyAt: '2026-10-17T07:10:00.000Z' }, 'READY');
    renderRoute('/orders/ord1');
    expect(await screen.findByText(/^Ready at/)).toBeVisible();
    expect(screen.queryByText(/Estimated ready/)).not.toBeInTheDocument();
  });
});

const kitchen = (extra: object = {}) => ({
  settings: { kitchenParallelOrders: 1, autoAcceptMode: 'MANUAL', autoAcceptMaxWaitMinutes: 30 },
  calibration: { factor: 1, learnedFactor: null, observations: 0 },
  dishes: [
    {
      id: 'i1',
      name: 'Masala chai',
      category: 'Hot drinks',
      prepMinutes: null,
      prepUpdatedAt: null,
      history: null,
      estimate: { minutes: 10, source: 'DEFAULT' },
    },
    {
      id: 'i2',
      name: 'Veg puff',
      category: 'Snacks',
      prepMinutes: 4,
      prepUpdatedAt: '2026-10-16T07:00:00.000Z',
      history: {
        emaMinutes: 3.5,
        observations: 7,
        lastDurationMinutes: 3,
        lastObservedAt: '2026-10-17T06:00:00.000Z',
      },
      estimate: { minutes: 3.5, source: 'HISTORY' },
    },
  ],
  ...extra,
});

describe('manager kitchen timing', () => {
  it('edits preparation times with validation and shows where each estimate comes from', async () => {
    const patches: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER'] })),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/kitchen': () => ({ status: 200, body: kitchen() }),
      'GET /staff/outlets/o1/kitchen/accuracy': () => ({
        status: 200,
        body: {
          accuracy: {
            days: 14,
            since: '',
            toleranceMinutes: 3,
            enoughData: false,
            acceptToReady: {
              evaluated: 0,
              meanAbsErrorMinutes: null,
              medianAbsErrorMinutes: null,
              withinTolerancePct: null,
            },
            prepStartToReady: {
              evaluated: 0,
              meanAbsErrorMinutes: null,
              medianAbsErrorMinutes: null,
              withinTolerancePct: null,
            },
            lateOrders: 0,
            lateThresholdMinutes: 5,
            perDay: [],
            autoAccept: {},
          },
        },
      }),
      'PATCH /staff/outlets/o1/kitchen/items/i1': (init) => {
        patches.push(JSON.parse(String(init.body)));
        return { status: 200, body: kitchen() };
      },
    });
    renderRoute('/manage/kitchen');
    expect(await screen.findByRole('heading', { name: 'Kitchen timing', level: 1 })).toBeVisible();
    expect(await screen.findByText('Default — not configured')).toBeVisible();
    expect(screen.getByText('From real orders')).toBeVisible();
    expect(screen.getByText(/1 dish has no configured time/)).toBeVisible();
    expect(
      await screen.findByText('Not enough completed orders to evaluate estimate accuracy yet.'),
    ).toBeVisible();

    const input = screen.getByLabelText('Configured Preparation Time for Masala chai (minutes)');
    await userEvent.type(input, '0');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preparation time for Masala chai' }),
    );
    expect(screen.getByText('Whole minutes, 1–180')).toBeVisible();
    expect(patches).toHaveLength(0);
    await userEvent.clear(input);
    await userEvent.type(input, '6');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preparation time for Masala chai' }),
    );
    await vi.waitFor(() => expect(patches).toEqual([{ prepMinutes: 6 }]));
  });

  it('turns auto-accept off with one click when it is on', async () => {
    const puts: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER'] })),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/kitchen': () => ({
        status: 200,
        body: kitchen({
          settings: {
            kitchenParallelOrders: 2,
            autoAcceptMode: 'AUTO',
            autoAcceptMaxWaitMinutes: 20,
          },
        }),
      }),
      'GET /staff/outlets/o1/kitchen/accuracy': () => ({
        status: 500,
        body: { error: { code: 'X', message: 'x' } },
      }),
      'PUT /staff/outlets/o1/kitchen/settings': (init) => {
        puts.push(JSON.parse(String(init.body)));
        return { status: 200, body: kitchen() };
      },
    });
    renderRoute('/manage/kitchen');
    const panel = await screen.findByText(/Auto-accept is on/);
    await userEvent.click(
      within(panel.parentElement!.parentElement!).getByRole('button', {
        name: 'Turn off auto-accept',
      }),
    );
    await vi.waitFor(() =>
      expect(puts).toEqual([
        { kitchenParallelOrders: 2, autoAcceptMode: 'MANUAL', autoAcceptMaxWaitMinutes: 20 },
      ]),
    );
  });
});
