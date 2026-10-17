import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: 'ord1',
  pickupCode: 'N-007',
  outlet: { id: 'o1', slug: 'night-owl-cafe', name: 'Night Owl Café' },
  status: 'PREPARING',
  paymentMethod: 'WALLET',
  paymentStatus: 'PAID',
  timing: 'IMMEDIATE',
  scheduledFor: null,
  scheduledFeePaise: 0,
  pickupDeadline: null,
  totalPaise: 4000,
  itemCount: 2,
  placedAt: '2026-10-16T08:00:00.000Z',
  version: 3,
  ...overrides,
});

describe('<OrdersPage />', () => {
  it('lists in-progress orders from the server and switches to past orders', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders': (init) => {
        void init;
        const view = new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://x').searchParams.get(
          'view',
        );
        return view === 'past'
          ? {
              status: 200,
              body: {
                orders: [
                  summary({
                    id: 'ord2',
                    pickupCode: 'N-003',
                    status: 'CANCELLED',
                    paymentStatus: 'REFUNDED',
                  }),
                ],
                nextCursor: null,
              },
            }
          : { status: 200, body: { orders: [summary()], nextCursor: null } };
      },
    });
    const { router } = renderRoute('/orders');
    const active = await screen.findByRole('list', { name: 'Orders in progress' });
    expect(within(active).getByRole('link')).toHaveAttribute('href', '/orders/ord1');
    expect(active).toHaveTextContent('N-007');
    expect(active).toHaveTextContent('2 items · ₹40');

    await userEvent.click(screen.getByRole('tab', { name: 'Past orders' }));
    const past = await screen.findByRole('list', { name: 'Past orders' });
    expect(past).toHaveTextContent('N-003');
    expect(past).toHaveTextContent('Cancelled');
    expect(router.state.location.search).toBe('?view=past');
  });

  it('shows an empty state with a way to start ordering', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders': () => ({ status: 200, body: { orders: [], nextCursor: null } }),
    });
    renderRoute('/orders');
    expect(await screen.findByText('Nothing in progress')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse outlets' })).toHaveAttribute('href', '/');
  });
});
