import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { outletRow } from '@/test/staff';
import type { InventoryItem } from '@/services/inventory';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stockItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'i1',
    name: 'Masala chai',
    imageUrl: null,
    pricePaise: 2000,
    dietary: 'VEG',
    isActive: true,
    category: { id: 'c1', name: 'Hot drinks', isActive: true },
    trackInventory: true,
    stockQuantity: 12,
    lowStockThreshold: 5,
    soldOutManually: false,
    stockStatus: 'AVAILABLE',
    soldOutReason: null,
    stockUpdatedAt: null,
    updatedAt: '2026-10-17T05:00:00.000Z',
    ...overrides,
  };
}

const items = [
  stockItem(),
  stockItem({
    id: 'i2',
    name: 'Veg puff',
    stockQuantity: 3,
    stockStatus: 'LOW_STOCK',
    category: { id: 'c2', name: 'Snacks', isActive: true },
  }),
  stockItem({
    id: 'i3',
    name: 'Samosa',
    trackInventory: false,
    stockQuantity: null,
    soldOutManually: true,
    stockStatus: 'SOLD_OUT',
    soldOutReason: 'MARKED_SOLD_OUT',
    category: { id: 'c2', name: 'Snacks', isActive: true },
  }),
];
const counts = { AVAILABLE: 1, LOW_STOCK: 1, SOLD_OUT: 1 };

type Handler = Parameters<typeof mockApi>[0][string];

function setup(roles: ('MANAGER' | 'POS')[], extra: Record<string, Handler> = {}) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', ...roles] })),
    'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow(roles)] } }),
    'GET /staff/outlets/o1/inventory': () => ({ status: 200, body: { items, counts } }),
    ...extra,
  });
}

const sent = (fetchMock: ReturnType<typeof setup>, path: string, method = 'POST') =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === `/api/v1${path}` && init?.method === method)
    .map(([, init]) => JSON.parse(String(init!.body)));

const row = (name: string) =>
  screen.getAllByRole('listitem').find((li) => within(li).queryByText(name, { exact: true }))!;

describe('stock management (manager)', () => {
  it('shows every item’s status, quantity and threshold, with low/sold-out totals', async () => {
    setup(['MANAGER']);
    renderRoute('/manage/stock');
    await screen.findByRole('list', { name: 'Stock' });
    expect(screen.getByText('1 running low · 1 sold out')).toBeInTheDocument();
    expect(row('Masala chai')).toHaveTextContent('In stock');
    expect(row('Masala chai')).toHaveTextContent('12 left · low at ≤ 5');
    expect(row('Veg puff')).toHaveTextContent('Low stock');
    expect(row('Samosa')).toHaveTextContent('Sold out');
    expect(row('Samosa')).toHaveTextContent('Not counted');
    expect(row('Samosa')).toHaveTextContent('Marked sold out by staff');
    expect(screen.getAllByRole('link', { name: 'Stock' })[0]).toHaveAttribute(
      'href',
      '/manage/stock',
    );
  });

  it('filters by status and search on the server', async () => {
    const fetchMock = setup(['MANAGER']);
    renderRoute('/manage/stock');
    await screen.findByRole('list', { name: 'Stock' });
    await userEvent.click(screen.getByRole('button', { name: 'Low stock (1)' }));
    await userEvent.type(screen.getByLabelText('Search items'), 'puff');
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
        '/api/v1/staff/outlets/o1/inventory?q=puff&status=LOW_STOCK',
      ),
    );
  });

  it('restocks with a validated quantity and shows the server’s new figure', async () => {
    const fetchMock = setup(['MANAGER'], {
      'POST /staff/outlets/o1/inventory/i1/adjustments': () => ({
        status: 200,
        body: { item: stockItem({ stockQuantity: 17 }) },
      }),
    });
    renderRoute('/manage/stock');
    await userEvent.click(await screen.findByRole('button', { name: 'Restock Masala chai' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restock Masala chai' });
    await userEvent.type(within(dialog).getByLabelText('Units to add'), '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add stock' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter how many units arrived');
    expect(sent(fetchMock, '/staff/outlets/o1/inventory/i1/adjustments')).toEqual([]);

    await userEvent.clear(within(dialog).getByLabelText('Units to add'));
    await userEvent.type(within(dialog).getByLabelText('Units to add'), '5');
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Delivery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add stock' }));
    expect(await screen.findByText('Masala chai: +5 → 17 in stock')).toBeInTheDocument();
    expect(sent(fetchMock, '/staff/outlets/o1/inventory/i1/adjustments')).toEqual([
      { type: 'RESTOCK', quantity: 5, reason: 'Delivery', markAvailable: false },
    ]);
  });

  it('requires a reason and stays within stock when removing', async () => {
    const fetchMock = setup(['MANAGER'], {
      'POST /staff/outlets/o1/inventory/i2/adjustments': () => ({
        status: 200,
        body: {
          item: stockItem({
            id: 'i2',
            name: 'Veg puff',
            stockQuantity: 1,
            stockStatus: 'LOW_STOCK',
          }),
        },
      }),
    });
    renderRoute('/manage/stock');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove stock of Veg puff' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Units to remove'), '4');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove stock' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('from 1 to 3');
    await userEvent.clear(within(dialog).getByLabelText('Units to remove'));
    await userEvent.type(within(dialog).getByLabelText('Units to remove'), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove stock' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Say why');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Damaged');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove stock' }));
    await waitFor(() =>
      expect(sent(fetchMock, '/staff/outlets/o1/inventory/i2/adjustments')).toEqual([
        { type: 'REMOVAL', quantity: 2, reason: 'Damaged' },
      ]),
    );
  });

  it('confirms before marking sold out, and uses the existing availability API', async () => {
    const fetchMock = setup(['MANAGER'], {
      'PATCH /staff/outlets/o1/items/i1/availability': () => ({ status: 200, body: { item: {} } }),
    });
    renderRoute('/manage/stock');
    await userEvent.click(
      await within(await waitFor(() => row('Masala chai'))).findByRole('button', {
        name: 'Mark sold out',
      }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Mark Masala chai sold out?' });
    expect(confirm).toHaveTextContent('restocking alone won’t');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Mark sold out' }));
    await waitFor(() =>
      expect(sent(fetchMock, '/staff/outlets/o1/items/i1/availability', 'PATCH')).toEqual([
        { isAvailable: false },
      ]),
    );
  });

  it('starts counting an untracked item with a real quantity and threshold', async () => {
    const fetchMock = setup(['MANAGER'], {
      'POST /staff/outlets/o1/inventory/i3/tracking': () => ({
        status: 200,
        body: { item: items[2] },
      }),
    });
    renderRoute('/manage/stock');
    await userEvent.click(await screen.findByRole('button', { name: 'Stock settings for Samosa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stock settings: Samosa' });
    await userEvent.type(within(dialog).getByLabelText('Units on hand'), '24');
    await userEvent.clear(within(dialog).getByLabelText('Low stock at or below'));
    await userEvent.type(within(dialog).getByLabelText('Low stock at or below'), '6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start counting stock' }));
    await waitFor(() =>
      expect(sent(fetchMock, '/staff/outlets/o1/inventory/i3/tracking')).toEqual([
        { enabled: true, quantity: 24, lowStockThreshold: 6 },
      ]),
    );
  });

  it('sets a stock count against the figure the manager saw', async () => {
    const fetchMock = setup(['MANAGER'], {
      'POST /staff/outlets/o1/inventory/i1/adjustments': () => ({
        status: 409,
        body: {
          error: {
            code: 'STOCK_CHANGED',
            message: 'The quantity changed while you were counting.',
          },
        },
      }),
    });
    renderRoute('/manage/stock');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Stock settings for Masala chai' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Stock count (recorded: 12)'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set count' }));
    expect(
      await within(dialog).findByText('The quantity changed while you were counting.'),
    ).toBeInTheDocument();
    expect(sent(fetchMock, '/staff/outlets/o1/inventory/i1/adjustments')).toEqual([
      { type: 'COUNT_SET', quantity: 10, expectedQuantity: 12, reason: 'Stock count' },
    ]);
  });

  it('shows the item’s stock history', async () => {
    setup(['MANAGER'], {
      'GET /staff/outlets/o1/inventory/i1/history': () => ({
        status: 200,
        body: {
          history: [
            {
              id: 'h1',
              type: 'ORDER_DEDUCTION',
              quantityChange: -2,
              previousQuantity: 14,
              resultingQuantity: 12,
              orderId: 'ord1',
              actor: { displayName: 'Asha', role: 'STUDENT' },
              reason: null,
              createdAt: '2026-10-17T05:00:00.000Z',
            },
          ],
        },
      }),
    });
    renderRoute('/manage/stock');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Stock history for Masala chai' }),
    );
    const list = await screen.findByRole('list', { name: 'Stock changes' });
    expect(list).toHaveTextContent('Ordered');
    expect(list).toHaveTextContent('−2');
    expect(list).toHaveTextContent('→ 12');
    expect(list).toHaveTextContent('Asha (STUDENT)');
  });
});

describe('stock at the counter (POS)', () => {
  it('lets POS restock and mark sold out, without manager settings', async () => {
    setup(['POS']);
    renderRoute('/pos/stock');
    await screen.findByRole('list', { name: 'Stock' });
    expect(screen.getByRole('button', { name: 'Restock Masala chai' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Stock settings/ })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Stock' })[0]).toHaveAttribute('href', '/pos/stock');
  });

  it('explains a refused change clearly', async () => {
    setup(['POS'], {
      'PATCH /staff/outlets/o1/items/i3/availability': () => ({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'You are not assigned to this outlet.' } },
      }),
    });
    renderRoute('/pos/stock');
    await userEvent.click(
      await within(await waitFor(() => row('Samosa'))).findByRole('button', {
        name: 'Make available',
      }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make available' }),
    );
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    expect(screen.getByText('You are not assigned to this outlet.')).toBeInTheDocument();
  });
});
