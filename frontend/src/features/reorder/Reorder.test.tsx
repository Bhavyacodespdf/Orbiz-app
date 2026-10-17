import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart, makeOrder } from '@/test/commerce';
import { makeMenuItem, makeOutlet } from '@/test/outlets';
import type { ReorderLine } from '@/services/reorder';

afterEach(() => {
  vi.unstubAllGlobals();
});

const outlet = {
  id: 'o1',
  name: 'Night Owl Café',
  slug: 'night-owl-cafe',
  status: 'OPEN',
  acceptingOrders: true,
};

function line(overrides: Partial<ReorderLine> = {}): ReorderLine {
  return {
    menuItemId: 'i1',
    name: 'Masala chai',
    imageUrl: null,
    dietary: 'VEG',
    categoryName: 'Hot drinks',
    stockStatus: 'AVAILABLE',
    rating: { average: null, count: 0 },
    requestedQuantity: 2,
    addableQuantity: 2,
    status: 'AVAILABLE',
    historicalUnitPricePaise: 2000,
    currentUnitPricePaise: 2000,
    priceChanged: false,
    alternatives: [],
    elsewhere: [],
    ...overrides,
  };
}

const puff = (overrides: Partial<ReorderLine> = {}) =>
  line({
    menuItemId: 'i2',
    name: 'Veg puff',
    requestedQuantity: 1,
    addableQuantity: 1,
    historicalUnitPricePaise: 3500,
    currentUnitPricePaise: 3500,
    ...overrides,
  });

function evaluated(lines: ReorderLine[], extra: object = {}) {
  const addable = lines.filter((l) => l.addableQuantity > 0);
  return {
    outlet,
    lines,
    addableCount: addable.length,
    currentTotalPaise: addable.reduce(
      (s, l) => s + l.currentUnitPricePaise! * l.addableQuantity,
      0,
    ),
    historicalTotalPaise: lines.reduce(
      (s, l) => s + (l.historicalUnitPricePaise ?? 0) * l.requestedQuantity,
      0,
    ),
    unchanged: lines.every((l) => l.status === 'AVAILABLE' && !l.priceChanged),
    ...extra,
  };
}

function historyCard(lines: ReorderLine[]) {
  return {
    orderId: 'ord1',
    label: 'Your previous lunch',
    placedAt: '2026-10-15T07:00:00.000Z',
    pickupCode: 'N-007',
    previousTotalPaise: 7500,
    timesOrdered: 3,
    ...evaluated(lines),
  };
}

const student = makeUser();

function home(handlers: Record<string, Parameters<typeof mockApi>[0][string]>) {
  return mockApi({
    'GET /auth/me': signedInAs(student),
    'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
    'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
    'GET /specials': () => ({ status: 200, body: { day: '2026-10-17', specials: [] } }),
    'GET /saved-combos': () => ({ status: 200, body: { combos: [] } }),
    'GET /reorder/combos': () => ({
      status: 200,
      body: { windowDays: 90, personalized: false, combos: [], popular: [] },
    }),
    ...handlers,
  });
}

describe('Quick Reorder on the home page', () => {
  it('shows a previous meal from real history and adds it in one tap when nothing changed', async () => {
    const posts: { key: string | null; body: unknown }[] = [];
    const lines = [line(), puff()];
    home({
      'GET /reorder/history': () => ({
        status: 200,
        body: { windowDays: 90, orders: [historyCard(lines)] },
      }),
      'POST /reorder/preview': () => ({
        status: 200,
        body: { preview: { source: { type: 'ORDER', orderId: 'ord1' }, ...evaluated(lines) } },
      }),
      'POST /reorder/cart': (init) => {
        posts.push({
          key: new Headers(init.headers).get('Idempotency-Key'),
          body: JSON.parse(String(init.body)),
        });
        return { status: 201, body: { cart: makeCart(), added: true } };
      },
    });
    renderRoute('/');

    const section = await screen.findByRole('region', { name: 'Quick reorder' });
    const card = within(section).getByRole('article');
    expect(within(card).getByRole('heading', { name: 'Your previous lunch' })).toBeVisible();
    expect(within(card).getByText('Masala chai × 2')).toBeVisible();
    expect(within(card).getByText('Veg puff × 1')).toBeVisible();
    expect(within(card).getByText(/Night Owl Café/)).toBeVisible();
    expect(within(card).getByText('Ordered 3 times in the last 90 days')).toBeVisible();
    expect(within(card).getByText('Available now')).toBeVisible();
    expect(within(section).getByRole('link', { name: 'Older orders' })).toHaveAttribute(
      'href',
      '/orders?view=past',
    );

    await userEvent.click(
      within(card).getByRole('button', { name: 'Reorder your previous lunch from Night Owl Café' }),
    );
    const done = await screen.findByRole('dialog', { name: 'Added to your tray' });
    expect(within(done).getByText(/Nothing is charged until you check out/)).toBeVisible();
    expect(within(done).getByRole('link', { name: /Review tray/ })).toHaveAttribute(
      'href',
      '/cart',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.key).toMatch(/^cc-/);
    expect(posts[0]!.body).toEqual({
      items: [
        { menuItemId: 'i1', quantity: 2 },
        { menuItemId: 'i2', quantity: 1 },
      ],
      expectedTotalPaise: 7500,
      replaceCart: false,
      source: { type: 'ORDER', orderId: 'ord1' },
    });
  });

  it('asks before adding when a dish is sold out or a price changed, and adds only what can be added', async () => {
    const posts: unknown[] = [];
    const lines = [
      line({ priceChanged: true, currentUnitPricePaise: 2500 }),
      puff({
        status: 'SOLD_OUT',
        addableQuantity: 0,
        stockStatus: 'SOLD_OUT',
        alternatives: [
          {
            menuItemId: 'i3',
            name: 'Egg puff',
            pricePaise: 3000,
            outlet: { id: 'o1', name: 'Night Owl Café', slug: 'night-owl-cafe' },
          },
        ],
      }),
    ];
    home({
      'GET /reorder/history': () => ({
        status: 200,
        body: { windowDays: 90, orders: [historyCard(lines)] },
      }),
      'POST /reorder/preview': () => ({
        status: 200,
        body: { preview: { source: { type: 'ORDER', orderId: 'ord1' }, ...evaluated(lines) } },
      }),
      'POST /reorder/cart': (init) => {
        posts.push(JSON.parse(String(init.body)));
        return { status: 201, body: { cart: makeCart(), added: true } };
      },
    });
    renderRoute('/');
    const card = within(await screen.findByRole('region', { name: 'Quick reorder' })).getByRole(
      'article',
    );
    expect(within(card).getByText('1 dish unavailable')).toBeVisible();
    await userEvent.click(within(card).getByRole('button', { name: /^Reorder/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Reorder your previous lunch' });
    expect(within(dialog).getByText('Price changed: was ₹20, now ₹25 each')).toBeVisible();
    const missing = within(dialog).getByRole('region', { name: 'Can’t be added' });
    expect(within(missing).getByText(/Sold out right now\. It won’t be added\./)).toBeVisible();
    // Alternatives are offered, never swapped in silently.
    expect(within(missing).getByRole('button', { name: 'Add Egg puff · ₹30' })).toBeVisible();
    expect(posts).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add 2 dishes · ₹50' }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      items: [{ menuItemId: 'i1', quantity: 2 }],
      expectedTotalPaise: 5000,
    });
    const done = await screen.findByRole('dialog', { name: 'Added to your tray' });
    expect(within(done).getByText('Not added: Veg puff.')).toBeVisible();
  });

  it('explains a tray from another outlet and replaces it only when the student agrees', async () => {
    const bodies: { replaceCart: boolean }[] = [];
    const keys: (string | null)[] = [];
    const lines = [line()];
    home({
      'GET /reorder/history': () => ({
        status: 200,
        body: { windowDays: 90, orders: [historyCard(lines)] },
      }),
      'POST /reorder/preview': () => ({
        status: 200,
        body: { preview: { source: null, ...evaluated(lines) } },
      }),
      'POST /reorder/cart': (init) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        keys.push(new Headers(init.headers).get('Idempotency-Key'));
        return body.replaceCart
          ? { status: 201, body: { cart: makeCart(), added: true } }
          : {
              status: 409,
              body: {
                error: {
                  code: 'CART_OUTLET_CONFLICT',
                  message: 'x',
                  details: { currentOutlet: { name: 'Juice Junction' } },
                },
              },
            };
      },
    });
    renderRoute('/');
    await userEvent.click(await screen.findByRole('button', { name: /^Reorder your previous/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Start a new tray?' });
    expect(within(confirm).getByText(/Your tray has dishes from Juice Junction/)).toBeVisible();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Replace tray' }));
    await screen.findByRole('dialog', { name: 'Added to your tray' });
    expect(bodies.map((b) => b.replaceCart)).toEqual([false, true]);
    expect(keys[0]).toBe(keys[1]); // the same intent, retried
  });
});

describe('favourite combos', () => {
  it('shows history-based combos with their real counts', async () => {
    home({
      'GET /reorder/history': () => ({ status: 200, body: { windowDays: 90, orders: [] } }),
      'GET /reorder/combos': () => ({
        status: 200,
        body: {
          windowDays: 90,
          personalized: true,
          popular: [],
          combos: [
            {
              key: 'BASKET:o1:i1,i2',
              kind: 'BASKET',
              name: 'Masala chai + Veg puff',
              explanation: 'Ordered together 4 times in the last 90 days',
              pattern: 'Usually for lunch, often on Tuesdays',
              timesOrdered: 4,
              lastOrderedAt: '2026-10-15T07:00:00.000Z',
              ...evaluated([line(), puff()], { historicalTotalPaise: null }),
            },
          ],
        },
      }),
    });
    renderRoute('/');
    const section = await screen.findByRole('region', { name: 'Your favourite combos' });
    expect(within(section).getByRole('heading', { name: 'Masala chai + Veg puff' })).toBeVisible();
    expect(
      within(section).getByText(
        'Ordered together 4 times in the last 90 days · Usually for lunch, often on Tuesdays',
      ),
    ).toBeVisible();
    expect(
      within(section).getByRole('button', { name: 'Customize Masala chai + Veg puff' }),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Quick reorder' })).not.toBeInTheDocument();
  });

  it('labels the popular fallback as not personalised, and shows an honest empty state', async () => {
    home({
      'GET /reorder/history': () => ({ status: 200, body: { windowDays: 90, orders: [] } }),
      'GET /reorder/combos': () => ({
        status: 200,
        body: {
          windowDays: 90,
          personalized: false,
          combos: [],
          popular: [
            {
              key: 'POPULAR:i2',
              name: 'Veg puff',
              explanation: 'Collected by 12 students in the last 30 days',
              students: 12,
              ...evaluated([puff({ historicalUnitPricePaise: null, priceChanged: false })], {
                historicalTotalPaise: null,
              }),
            },
          ],
        },
      }),
    });
    renderRoute('/');
    expect(
      await screen.findByText(/Once you’ve collected a few orders, the dishes you order together/),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Popular on campus' })).toBeVisible();
    expect(screen.getByText(/Not personalised/)).toBeVisible();
    expect(screen.getByText('Collected by 12 students in the last 30 days')).toBeVisible();
  });

  it('is not shown to signed-out visitors', async () => {
    mockApi({
      'GET /auth/me': () => ({
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'x' } },
      }),
      'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
      'GET /specials': () => ({ status: 200, body: { day: '2026-10-17', specials: [] } }),
    });
    renderRoute('/');
    expect(await screen.findByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Your favourite combos' })).not.toBeInTheDocument();
  });
});

describe('customize', () => {
  it('recalculates on the server as quantities change and saves the combo', async () => {
    const quotes: unknown[] = [];
    const saves: unknown[] = [];
    home({
      'GET /reorder/history': () => ({
        status: 200,
        body: { windowDays: 90, orders: [historyCard([line(), puff()])] },
      }),
      'GET /outlets/night-owl-cafe/menu': () => ({
        status: 200,
        body: {
          outlet: makeOutlet(),
          categories: [{ id: 'c1', name: 'Hot drinks', sortOrder: 0 }],
          items: [
            makeMenuItem(),
            makeMenuItem({ id: 'i9', name: 'Filter coffee', pricePaise: 3000 }),
          ],
        },
      }),
      'POST /reorder/preview': (init) => {
        const body = JSON.parse(String(init.body)) as {
          items: { menuItemId: string; quantity: number }[];
        };
        quotes.push(body);
        const lines = body.items.map((i) =>
          i.menuItemId === 'i1'
            ? line({
                requestedQuantity: i.quantity,
                addableQuantity: i.quantity,
                historicalUnitPricePaise: null,
              })
            : i.menuItemId === 'i9'
              ? line({
                  menuItemId: 'i9',
                  name: 'Filter coffee',
                  requestedQuantity: i.quantity,
                  addableQuantity: i.quantity,
                  currentUnitPricePaise: 3000,
                  historicalUnitPricePaise: null,
                })
              : puff({
                  requestedQuantity: i.quantity,
                  addableQuantity: i.quantity,
                  historicalUnitPricePaise: null,
                }),
        );
        return {
          status: 200,
          body: { preview: { source: null, ...evaluated(lines, { historicalTotalPaise: null }) } },
        };
      },
      'POST /saved-combos': (init) => {
        saves.push(JSON.parse(String(init.body)));
        return { status: 201, body: { combo: {} } };
      },
    });
    renderRoute('/');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Customize Your previous lunch' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Customize: Your previous lunch' });
    expect(await within(dialog).findByText('₹75')).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Veg puff' }));
    expect(await within(dialog).findByText('₹40')).toBeVisible();
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Add a dish from this outlet'),
      'i9',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('₹70')).toBeVisible();
    expect(quotes.at(-1)).toEqual({
      items: [
        { menuItemId: 'i1', quantity: 2 },
        { menuItemId: 'i9', quantity: 1 },
      ],
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save combo' }));
    expect(within(dialog).getByText('Name your combo.')).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText(/Save for next time/), 'Exam fuel');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save combo' }));
    await vi.waitFor(() =>
      expect(saves).toEqual([
        {
          name: 'Exam fuel',
          items: [
            { menuItemId: 'i1', quantity: 2 },
            { menuItemId: 'i9', quantity: 1 },
          ],
        },
      ]),
    );
  });
});

describe('order page', () => {
  it('offers Reorder only on a collected order', async () => {
    mockApi({
      'GET /auth/me': signedInAs(student),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      'GET /orders/ord1': () => ({
        status: 200,
        body: { order: makeOrder({ status: 'COMPLETED' }) },
      }),
      'GET /orders/ord2': () => ({
        status: 200,
        body: { order: makeOrder({ id: 'ord2', status: 'CANCELLED', paymentStatus: 'REFUNDED' }) },
      }),
    });
    const { router } = renderRoute('/orders/ord1');
    expect(await screen.findByRole('button', { name: 'Reorder' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Customize' })).toBeVisible();
    await router.navigate('/orders/ord2');
    expect(await screen.findByText(/This order was cancelled/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reorder' })).not.toBeInTheDocument();
  });
});
