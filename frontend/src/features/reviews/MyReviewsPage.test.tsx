import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

const own = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  rating: 4,
  body: 'Good chai',
  feedback: { taste: null, portion: null, freshness: null, value: null },
  verifiedPurchase: true,
  author: 'Asha',
  isMine: true,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
  edited: true,
  status: 'PUBLISHED',
  moderationReason: null,
  item: { id: 'i1', name: 'Masala chai', isActive: true },
  outlet: { slug: 'night-owl-cafe', name: 'Night Owl Café' },
  ...overrides,
});

describe('my reviews', () => {
  it('lists my reviews with dates and status, and deletes after confirming', async () => {
    const deleted: string[] = [];
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      'GET /me/reviews': () => ({
        status: 200,
        body: {
          reviews: [
            own(),
            own({
              id: 'r2',
              item: { id: 'i2', name: 'Egg puff', isActive: true },
              status: 'HIDDEN',
              moderationReason: 'Off-topic',
            }),
          ],
          page: 1,
          pageSize: 10,
          total: 2,
          hasMore: false,
        },
      }),
      'DELETE /reviews/r1': () => {
        deleted.push('r1');
        return { status: 204 };
      },
    });
    renderRoute('/reviews');
    const chai = await screen.findByRole('link', { name: 'Masala chai' });
    expect(chai).toHaveAttribute('href', '/outlets/night-owl-cafe/items/i1');
    expect(screen.getAllByText(/edited/).length).toBeGreaterThan(0);
    expect(screen.getByText('Hidden by the outlet')).toBeVisible();
    expect(screen.getByText('Reason: “Off-topic”')).toBeVisible();

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete your review of Masala chai' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete your review?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete review' }));
    await vi.waitFor(() => expect(deleted).toEqual(['r1']));
  });

  it('points to orders when there are no reviews yet', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      'GET /me/reviews': () => ({
        status: 200,
        body: { reviews: [], page: 1, pageSize: 10, total: 0, hasMore: false },
      }),
    });
    renderRoute('/reviews');
    expect(await screen.findByText('No reviews yet')).toBeVisible();
    expect(screen.getByRole('link', { name: 'See your orders' })).toBeVisible();
  });
});
