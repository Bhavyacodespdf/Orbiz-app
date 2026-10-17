import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { mockApi, signedOut } from '@/test/api';
import { makeMenuItem, makeOutlet } from '@/test/outlets';

afterEach(() => {
  vi.unstubAllGlobals();
});

const categories = [
  { id: 'c1', name: 'Hot drinks', sortOrder: 0 },
  { id: 'c2', name: 'Snacks', sortOrder: 1 },
];
const items = [
  makeMenuItem(),
  makeMenuItem({ id: 'i2', categoryId: 'c2', name: 'Egg puff', pricePaise: 3550, dietary: 'EGG' }),
  makeMenuItem({
    id: 'i3',
    categoryId: 'c2',
    name: 'Chicken sandwich',
    dietary: 'NON_VEG',
    isAvailable: false,
  }),
];

function menuApi(outlet = makeOutlet()) {
  return mockApi({
    'GET /auth/me': signedOut,
    'GET /outlets/night-owl-cafe/menu': () => ({
      status: 200,
      body: { outlet, categories, items },
    }),
  });
}

describe('<OutletPage />', () => {
  it('shows the menu grouped by category with server prices, dietary marks and sold-out items', async () => {
    menuApi();
    renderRoute('/outlets/night-owl-cafe');
    expect(
      await screen.findByRole('heading', { name: 'Night Owl Café', level: 1 }),
    ).toBeInTheDocument();

    const snacks = screen.getByRole('region', { name: 'Snacks' });
    expect(within(snacks).getByText('₹35.50')).toBeInTheDocument();
    expect(within(snacks).getByRole('img', { name: 'Contains egg' })).toBeInTheDocument();
    expect(within(snacks).getByRole('img', { name: 'Non-vegetarian' })).toBeInTheDocument();
    expect(within(snacks).getByText('Sold out')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Hot drinks' })).getByText('₹20'),
    ).toBeInTheDocument();
  });

  it('explains when the outlet is closed', async () => {
    menuApi(makeOutlet({ status: 'CLOSED', acceptingOrders: false }));
    renderRoute('/outlets/night-owl-cafe');
    expect(await screen.findByText(/closed right now/)).toBeInTheDocument();
  });

  it('applies veg-only and category filters on the server and keeps them in the URL', async () => {
    const fetchMock = menuApi();
    const { router } = renderRoute('/outlets/night-owl-cafe');
    await screen.findByRole('heading', { name: 'Night Owl Café', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Veg only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Snacks' }));

    expect(screen.getByRole('button', { name: 'Veg only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Snacks' })).toHaveAttribute('aria-pressed', 'true');
    expect(router.state.location.search).toBe('?veg=1&category=c2');
    const last = String(fetchMock.mock.calls.at(-1)![0]);
    expect(last).toBe('/api/v1/outlets/night-owl-cafe/menu?category=c2&dietary=VEG');
  });

  it('shows "Outlet not found" for an unknown outlet', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets/nope/menu': () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Outlet not found' } },
      }),
    });
    renderRoute('/outlets/nope');
    expect(await screen.findByText('Outlet not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all outlets' })).toHaveAttribute('href', '/');
  });
});

describe('stock labels on the menu', () => {
  it('shows "Few left" for low stock (still orderable) and "Sold out" otherwise', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets/night-owl-cafe/menu': () => ({
        status: 200,
        body: {
          outlet: makeOutlet(),
          categories,
          items: [
            makeMenuItem({ stockStatus: 'LOW_STOCK' }),
            makeMenuItem({
              id: 'i2',
              categoryId: 'c2',
              name: 'Veg puff',
              isAvailable: false,
              stockStatus: 'SOLD_OUT',
            }),
          ],
        },
      }),
    });
    renderRoute('/outlets/night-owl-cafe');
    const drinks = await screen.findByRole('region', { name: 'Hot drinks' });
    expect(within(drinks).getByText('Few left')).toBeInTheDocument();
    expect(within(drinks).getByRole('button', { name: /Add Masala chai/ })).toBeEnabled();
    const snacks = screen.getByRole('region', { name: 'Snacks' });
    expect(within(snacks).getByText('Sold out')).toBeInTheDocument();
    expect(within(snacks).queryByRole('button', { name: /Add Veg puff/ })).toBeNull();
  });
});
