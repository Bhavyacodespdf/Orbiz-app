import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs, signedOut } from '@/test/api';
import { makeCart, makeOrder } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

const note = (id: string, title: string, read = false, extra: object = {}) => ({
  id,
  type: 'ORDER_READY',
  title,
  body: 'Collect it at Night Owl Café.',
  link: '/orders/ord1',
  entity: { type: 'Order', id: 'ord1' },
  read,
  readAt: read ? '2026-10-17T07:00:00.000Z' : null,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  ...extra,
});

describe('notification center', () => {
  it('shows the unread count, opens a notification, marks it read and goes to the order', async () => {
    const posts: string[] = [];
    let unread = 2;
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
      'GET /specials': () => ({ status: 200, body: { day: '2026-10-17', specials: [] } }),
      'GET /saved-combos': () => ({ status: 200, body: { combos: [] } }),
      'GET /reorder/history': () => ({ status: 200, body: { windowDays: 90, orders: [] } }),
      'GET /reorder/combos': () => ({
        status: 200,
        body: { windowDays: 90, personalized: false, combos: [], popular: [] },
      }),
      'GET /me/notifications/unread-count': () => ({ status: 200, body: { unread } }),
      'GET /me/notifications': () => ({
        status: 200,
        body: {
          notifications: [note('n2', 'Order N-007 is ready'), note('n1', 'Order N-007 accepted')],
          unread,
          nextCursor: null,
        },
      }),
      'POST /me/notifications/n2/read': () => {
        posts.push('read n2');
        unread = 1;
        return { status: 200, body: { ok: true } };
      },
      'POST /me/notifications/read-all': () => {
        posts.push('read all');
        unread = 0;
        return { status: 200, body: { marked: 1 } };
      },
      'GET /orders/ord1': () => ({ status: 200, body: { order: makeOrder() } }),
      'GET /orders/ord1/pickup': () => ({ status: 200, body: { pickup: { state: 'NOT_READY' } } }),
    });
    const { router } = renderRoute('/');
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    await userEvent.click(bell);
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    const list = await within(dialog).findByRole('list', { name: 'Notifications' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(within(list).getByText('Order N-007 is ready')).toBeVisible();

    await userEvent.click(within(list).getByRole('button', { name: /Order N-007 is ready/ }));
    await vi.waitFor(() => expect(posts).toContain('read n2'));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/orders/ord1'));

    await userEvent.click(await screen.findByRole('button', { name: /^Notifications/ }));
    const again = await screen.findByRole('dialog', { name: 'Notifications' });
    await userEvent.click(within(again).getByRole('button', { name: 'Mark all as read' }));
    await vi.waitFor(() => expect(posts).toContain('read all'));
  });

  it('is hidden when signed out', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
      'GET /specials': () => ({ status: 200, body: { day: '2026-10-17', specials: [] } }),
    });
    renderRoute('/');
    expect(await screen.findByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument();
  });
});
