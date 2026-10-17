import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { outletRow } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const menu = {
  outlet: { ...outletRow().outlet, isActive: true },
  categories: [{ id: 'c1', name: 'Snacks', sortOrder: 0, isActive: true }],
  items: [
    {
      id: 'i1',
      categoryId: 'c1',
      name: 'Samosa',
      description: 'Crisp',
      pricePaise: 1500,
      dietary: 'VEG',
      isAvailable: true,
      imageUrl: null,
      isActive: true,
      sortOrder: 0,
      stockStatus: 'AVAILABLE',
      soldOutManually: false,
      fulfillmentType: 'HANDMADE',
      trackInventory: false,
      stockQuantity: null,
      lowStockThreshold: 0,
      stockUpdatedAt: null,
    },
  ],
};

function setup(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER'] })),
    'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
    'GET /staff/outlets/o1/menu': () => ({ status: 200, body: menu }),
    ...extra,
  });
}

describe('menu management', () => {
  it('adds an item, converting the rupee price to exact paise', async () => {
    const bodies: unknown[] = [];
    setup({
      'POST /staff/outlets/o1/items': (init) => {
        bodies.push(JSON.parse(String(init.body)));
        return { status: 201, body: {} };
      },
    });
    renderRoute('/manage/menu');
    await userEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add menu item' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Veg puff');
    await userEvent.type(within(dialog).getByLabelText('Price'), '45.5');
    await userEvent.selectOptions(within(dialog).getByLabelText('Food type'), 'VEG');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    // The packaged/handmade classification is required for the no-show policy.
    expect(await within(dialog).findByText('Choose packaged or handmade')).toBeInTheDocument();
    expect(bodies).toEqual([]);
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Packaged or handmade'),
      'PACKAGED',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await vi.waitFor(() =>
      expect(bodies).toEqual([
        {
          name: 'Veg puff',
          description: '',
          pricePaise: 4550,
          dietary: 'VEG',
          categoryId: 'c1',
          fulfillmentType: 'PACKAGED',
        },
      ]),
    );
  });

  it('rejects invalid prices before sending anything', async () => {
    const fetchMock = setup();
    renderRoute('/manage/menu');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Samosa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Samosa' });
    const price = within(dialog).getByLabelText('Price');
    expect(price).toHaveValue('15');
    await userEvent.clear(price);
    await userEvent.type(price, '12.345');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText(/Enter a price from ₹1 to ₹10,000/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('marks an item sold out and hides an item without deleting it', async () => {
    const calls: [string, unknown][] = [];
    setup({
      'PATCH /staff/outlets/o1/items/i1/availability': (init) => {
        calls.push(['availability', JSON.parse(String(init.body))]);
        return { status: 200, body: {} };
      },
      'PATCH /staff/outlets/o1/items/i1': (init) => {
        calls.push(['item', JSON.parse(String(init.body))]);
        return { status: 200, body: {} };
      },
    });
    renderRoute('/manage/menu');
    await userEvent.click(await screen.findByRole('switch', { name: 'Samosa available' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide Samosa' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ['availability', { isAvailable: false }],
        ['item', { isActive: false }],
      ]),
    );
  });
});
