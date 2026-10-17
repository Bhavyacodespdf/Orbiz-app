import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart } from '@/test/commerce';
import { makeOutlet } from '@/test/outlets';
import type { Combo, ComboItem } from '@/services/surprise';

afterEach(() => {
  vi.unstubAllGlobals();
});

const options = {
  budget: {
    minPaise: 5_000,
    maxPaise: 100_000,
    stepPaise: 1_000,
    presets: [
      { label: 'Snack', budgetPaise: 8_000 },
      { label: 'Lunch', budgetPaise: 14_000 },
      { label: 'Power', budgetPaise: 20_000 },
      { label: 'Feast', budgetPaise: 30_000 },
    ],
  },
  moods: ['QUICK_BITE', 'HIGH_PROTEIN', 'CAFE_TREAT', 'FEAST'],
  diets: ['ANY', 'VEG', 'NON_VEG'],
  aiAvailable: false,
};

const dish = (id: string, name: string, pricePaise: number, category = 'Meals'): ComboItem => ({
  id,
  name,
  description: '',
  pricePaise,
  dietary: 'VEG',
  imageUrl: null,
  category: { id: `c-${category}`, name: category },
  rating: { average: null, count: 0 },
});

const thali = dish('thali', 'Veg thali', 12_000);
const chai = dish('chai', 'Masala chai', 2_000, 'Hot drinks');
const puff = dish('puff', 'Veg puff', 3_000, 'Snacks');

function combo(items: ComboItem[], budgetPaise = 14_000): Combo {
  const totalPaise = items.reduce((s, i) => s + i.pricePaise, 0);
  return {
    source: 'RULES',
    outlet: { id: 'o1', name: 'Night Owl Café', slug: 'night-owl-cafe' },
    items,
    itemCount: items.length,
    totalPaise,
    budgetPaise,
    remainingPaise: budgetPaise - totalPaise,
    reasons: ['Mixes Meals and Hot drinks.'],
    nutrition: {
      available: false,
      note: 'Calories, protein and preparation times aren’t recorded.',
    },
  };
}

type Handler = Parameters<typeof mockApi>[0][string];

function setup(handlers: Record<string, Handler> = {}) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser()),
    'GET /surprise-meal/options': () => ({ status: 200, body: options }),
    'GET /outlets': () => ({ status: 200, body: { outlets: [makeOutlet()] } }),
    'GET /cart': () => ({ status: 200, body: { cart: makeCart() } }),
    'POST /surprise-meal/generate': (init) => {
      const body = JSON.parse(String(init.body));
      return {
        status: 200,
        body: { combo: combo([thali, chai], body.budgetPaise), reason: null, notices: [] },
      };
    },
    ...handlers,
  });
}

const bodies = (fetchMock: ReturnType<typeof setup>, path: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === `/api/v1${path}` && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)));

describe('<SurpriseMealPage />', () => {
  it('shows the server’s combo with total, remaining budget and honest nutrition note', async () => {
    setup();
    renderRoute('/surprise');
    const card = await screen.findByRole('region', { name: 'Recommended combo' });
    expect(within(card).getByText('₹140')).toBeInTheDocument();
    expect(within(card).getByText('Budget fully used')).toBeInTheDocument();
    expect(within(card).getByText('2 dishes')).toBeInTheDocument();
    const rows = within(card).getAllByRole('listitem').slice(0, 2);
    expect(rows[0]).toHaveTextContent('Veg thali');
    expect(rows[0]).toHaveTextContent('₹120');
    expect(rows[1]).toHaveTextContent('Masala chai');
    expect(within(card).getByText(/aren’t recorded/)).toBeInTheDocument();
    expect(within(card).getByText(/no AI model is connected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Combo to Tray · ₹140' })).toBeEnabled();
  });

  it('quick picks move the slider and are sent as the budget', async () => {
    const fetchMock = setup();
    renderRoute('/surprise');
    await screen.findByRole('region', { name: 'Recommended combo' });
    await userEvent.click(screen.getByRole('button', { name: '₹300 Feast' }));
    expect(screen.getByRole('slider', { name: 'Maximum budget' })).toHaveValue('30000');
    expect(screen.getByRole('button', { name: '₹300 Feast' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(bodies(fetchMock, '/surprise-meal/generate').at(-1)).toMatchObject({
        budgetPaise: 30_000,
      }),
    );
    expect(await screen.findByText('₹160 under your ₹300 budget')).toBeInTheDocument();
  });

  it('sends the chosen mood, diet and outlet; only one mood is selected', async () => {
    const fetchMock = setup();
    renderRoute('/surprise');
    await screen.findByRole('region', { name: 'Recommended combo' });
    await userEvent.click(screen.getByRole('radio', { name: /Cafe & Treat/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'Veg' }));
    await userEvent.selectOptions(screen.getByLabelText('Outlet'), 'o1');
    expect(screen.getByRole('radio', { name: /Cafe & Treat/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Quick Bite/ })).not.toBeChecked();
    await waitFor(() =>
      expect(bodies(fetchMock, '/surprise-meal/generate').at(-1)).toEqual({
        budgetPaise: 14_000,
        mood: 'CAFE_TREAT',
        diet: 'VEG',
        outletId: 'o1',
        avoidItemIds: [],
      }),
    );
  });

  it('re-spins with the current combo marked to avoid', async () => {
    const fetchMock = setup();
    renderRoute('/surprise');
    await screen.findByRole('region', { name: 'Recommended combo' });
    await userEvent.click(screen.getByRole('button', { name: 'Re-spin Surprise Combo' }));
    await waitFor(() =>
      expect(bodies(fetchMock, '/surprise-meal/generate').at(-1)).toMatchObject({
        avoidItemIds: ['thali', 'chai'],
      }),
    );
  });

  it('explains when no combo fits instead of inventing one', async () => {
    setup({
      'POST /surprise-meal/generate': () => ({
        status: 200,
        body: {
          combo: null,
          reason: {
            code: 'BUDGET_TOO_LOW',
            message: 'The cheapest matching dish costs ₹90.',
            cheapestPaise: 9_000,
          },
          notices: [],
        },
      }),
    });
    renderRoute('/surprise');
    expect(await screen.findByText('No combo fits these choices')).toBeInTheDocument();
    expect(screen.getByText('The cheapest matching dish costs ₹90.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add Combo to Tray/ })).toBeNull();
  });

  it('swaps one dish and keeps the rest', async () => {
    const fetchMock = setup({
      'POST /surprise-meal/swap': () => ({
        status: 200,
        body: {
          swapped: true,
          message: 'Swapped Masala chai for Veg puff.',
          combo: combo([thali, puff], 15_000),
          notices: [],
        },
      }),
    });
    renderRoute('/surprise');
    await userEvent.click(await screen.findByRole('button', { name: 'Swap Masala chai' }));
    expect(await screen.findByText('Veg puff')).toBeInTheDocument();
    expect(screen.getByText('Veg thali')).toBeInTheDocument();
    expect(screen.queryByText('Masala chai')).toBeNull();
    expect(bodies(fetchMock, '/surprise-meal/swap')[0]).toMatchObject({
      itemIds: ['thali', 'chai'],
      replaceItemId: 'chai',
    });
  });

  it('keeps the dish and explains when no swap fits', async () => {
    setup({
      'POST /surprise-meal/swap': () => ({
        status: 200,
        body: {
          swapped: false,
          message: 'No other dish fits the ₹20 available for Masala chai, so it stays.',
          combo: combo([thali, chai]),
          notices: [],
        },
      }),
    });
    renderRoute('/surprise');
    await userEvent.click(await screen.findByRole('button', { name: 'Swap Masala chai' }));
    expect(await screen.findByText(/No other dish fits the ₹20/)).toBeInTheDocument();
    expect(screen.getByText('Masala chai')).toBeInTheDocument();
  });

  it('adds the combo to the existing tray with one key, and offers to replace another outlet’s tray', async () => {
    let attempts = 0;
    const fetchMock = setup({
      'POST /cart/combo': (init) => {
        attempts += 1;
        const body = JSON.parse(String(init.body));
        if (!body.replaceCart) {
          return {
            status: 409,
            body: {
              error: {
                code: 'CART_OUTLET_CONFLICT',
                message: 'x',
                details: {
                  currentOutlet: { id: 'o2', name: 'Tandoor Corner', slug: 'tandoor-corner' },
                },
              },
            },
          };
        }
        return { status: 201, body: { cart: makeCart(), added: true } };
      },
    });
    renderRoute('/surprise');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Combo to Tray · ₹140' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start a new tray?' });
    expect(dialog).toHaveTextContent('Tandoor Corner');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace tray' }));

    expect(
      await screen.findByText('Combo added to your tray from Night Owl Café.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View tray' })).toHaveAttribute('href', '/cart');
    const calls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/cart/combo');
    expect(attempts).toBe(2);
    expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({
      items: [
        { menuItemId: 'thali', quantity: 1 },
        { menuItemId: 'chai', quantity: 1 },
      ],
      expectedTotalPaise: 14_000,
      replaceCart: true,
    });
    const keys = calls.map(([, init]) => new Headers(init!.headers).get('Idempotency-Key'));
    expect(keys[0]).toMatch(/^cc-/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('explains changed prices instead of adding a stale combo', async () => {
    setup({
      'POST /cart/combo': () => ({
        status: 409,
        body: {
          error: { code: 'PRICE_CHANGED', message: 'Prices changed since this combo was made.' },
        },
      }),
    });
    renderRoute('/surprise');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Combo to Tray · ₹140' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Prices changed since this combo was made. Re-spin for an up-to-date combo.',
    );
  });

  it('shows an error with retry when the solver can’t be reached', async () => {
    setup({
      'POST /surprise-meal/generate': () => ({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
      }),
    });
    renderRoute('/surprise');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t make a combo');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
