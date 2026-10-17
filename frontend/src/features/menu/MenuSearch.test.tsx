import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs, signedOut } from '@/test/api';
import { makeCart } from '@/test/commerce';
import { makeMenuItem, makeOutlet } from '@/test/outlets';

afterEach(() => {
  vi.unstubAllGlobals();
});

const atrium = makeOutlet({ id: 'o2', slug: 'central-food-atrium', name: 'Central Food Atrium' });
const owl = makeOutlet();

const dish = (id: string, name: string, pricePaise: number, extra: object = {}) => ({
  ...makeMenuItem({ id, name, pricePaise }),
  category: { id: 'c1', name: 'Mains' },
  outlet: atrium,
  orders30d: null,
  popular: false,
  mine: null,
  ...extra,
});

function page(items: object[], extra: object = {}) {
  return {
    status: 200,
    body: {
      items,
      total: items.length,
      page: 1,
      pageSize: 24,
      hasMore: false,
      sort: null,
      quickReorder: null,
      popularWindowDays: null,
      filters: {
        outlets: [
          { id: 'o2', name: 'Central Food Atrium', slug: 'central-food-atrium' },
          { id: 'o1', name: 'Night Owl Café', slug: 'night-owl-cafe' },
        ],
        categories: [],
      },
      ...extra,
    },
  };
}

const urls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://x'));

describe('campus menu', () => {
  it('searches, sorts and filters on the server, keeping the sort while the search changes', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedOut,
      'GET /menu': () =>
        page([dish('d1', 'Paneer Tikka Wrap', 9000), dish('d2', 'Paneer Shake', 6000)]),
    });
    renderRoute('/menu');
    expect(await screen.findByText('Paneer Tikka Wrap')).toBeVisible();
    expect(screen.getAllByText(/Central Food Atrium/).length).toBeGreaterThan(0);
    expect(screen.getByText('Showing 2 of 2 dishes')).toBeVisible();

    // Exactly the five options, in order.
    const sortGroup = screen.getByRole('group', { name: 'Sort by' });
    expect(
      within(sortGroup)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Popular',
      'Price: Low to High',
      'Price: High to Low',
      'Quick Reorder',
      'Highest Rated',
    ]);
    const lowHigh = within(sortGroup).getByRole('button', { name: 'Price: Low to High' });
    await userEvent.click(lowHigh);
    expect(lowHigh).toHaveAttribute('aria-pressed', 'true');
    await vi.waitFor(() =>
      expect(urls(fetchMock).some((u) => u.searchParams.get('sort') === 'price-asc')).toBe(true),
    );

    await userEvent.type(screen.getByLabelText('Search dishes, categories or outlets'), 'PANEER');
    await vi.waitFor(() =>
      expect(
        urls(fetchMock).some(
          (u) => u.searchParams.get('q') === 'PANEER' && u.searchParams.get('sort') === 'price-asc',
        ),
      ).toBe(true),
    );

    await userEvent.selectOptions(screen.getByLabelText('Outlet'), 'o2');
    await vi.waitFor(() =>
      expect(
        urls(fetchMock).some(
          (u) => u.searchParams.get('outletId') === 'o2' && u.searchParams.get('page') === '1',
        ),
      ).toBe(true),
    );
  });

  it('shows a friendly empty state whose clear action keeps the sort', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedOut,
      'GET /menu': () => page([]),
    });
    renderRoute('/menu?q=sushi&sort=highest-rated');
    expect(await screen.findByText('Nothing matches “sushi”')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    await vi.waitFor(() => {
      const last = urls(fetchMock).at(-1)!;
      expect(last.searchParams.get('q')).toBeNull();
      expect(last.searchParams.get('sort')).toBe('highest-rated');
    });
  });

  it('loads the next page on demand', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedOut,
      'GET /menu': () => {
        const p = Number(urls(fetchMock).at(-1)!.searchParams.get('page'));
        return p === 1
          ? page([dish('d1', 'Wrap', 9000)], { total: 2, hasMore: true })
          : page([dish('d2', 'Shake', 6000)], { total: 2, page: 2, hasMore: false });
      },
    });
    renderRoute('/menu');
    expect(await screen.findByText('Showing 1 of 2 dishes')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Show more dishes' }));
    expect(await screen.findByText('Shake')).toBeVisible();
    expect(screen.getByText('Showing 2 of 2 dishes')).toBeVisible();
  });

  it('explains Quick Reorder to signed-out visitors instead of failing', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      'GET /menu': () =>
        page([dish('d1', 'Wrap', 9000)], {
          sort: 'quick-reorder',
          quickReorder: { signedIn: false, hasHistory: false, windowDays: 90 },
        }),
    });
    renderRoute('/menu?sort=quick-reorder');
    const note = await screen.findByText(/to see the dishes you’ve ordered before first/);
    expect(note).toBeVisible();
    expect(within(note).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Fmenu%3Fsort%3Dquick-reorder',
    );
    expect(screen.getByText('Wrap')).toBeVisible();
  });
});

describe('outlet menu sorting', () => {
  it('shows one ranked list with real popularity and the student’s own history', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      'GET /outlets/night-owl-cafe/menu': () => {
        const sort = urls(fetchMock).at(-1)!.searchParams.get('sort');
        return {
          status: 200,
          body: {
            outlet: owl,
            categories: [{ id: 'c1', name: 'Hot drinks', sortOrder: 0 }],
            items:
              sort === 'popular'
                ? [
                    {
                      ...makeMenuItem({ id: 'i2', name: 'Veg puff' }),
                      orders30d: 12,
                      popular: true,
                    },
                    { ...makeMenuItem(), orders30d: 1, popular: false },
                  ]
                : sort === 'quick-reorder'
                  ? [
                      {
                        ...makeMenuItem(),
                        mine: { orders: 2, lastOrderedAt: '2026-10-12T07:00:00.000Z' },
                      },
                    ]
                  : [makeMenuItem(), makeMenuItem({ id: 'i2', name: 'Veg puff' })],
            sort,
            popularWindowDays: sort === 'popular' ? 30 : null,
            quickReorder:
              sort === 'quick-reorder'
                ? { signedIn: true, hasHistory: true, windowDays: 90 }
                : null,
          },
        };
      },
    });
    renderRoute('/outlets/night-owl-cafe');
    expect(await screen.findByRole('region', { name: 'Hot drinks' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Popular' }));
    const ranked = await screen.findByRole('list', { name: 'Dishes sorted by Popular' });
    const rows = within(ranked).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Popular · 12 orders in 30 days')).toBeVisible();
    expect(within(rows[1]!).queryByText(/Popular ·/)).not.toBeInTheDocument();
    expect(screen.getByText('2 dishes · sorted by Popular')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Quick Reorder' }));
    expect(await screen.findByText(/You’ve ordered this 2 times/)).toBeVisible();
    // Choosing the active sort again goes back to the usual grouped menu.
    await userEvent.click(screen.getByRole('button', { name: 'Quick Reorder' }));
    expect(await screen.findByRole('region', { name: 'Hot drinks' })).toBeVisible();
  });
});
