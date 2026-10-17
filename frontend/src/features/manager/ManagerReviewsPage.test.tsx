import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart } from '@/test/commerce';
import { outletRow } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const manager = makeUser({ roles: ['STUDENT', 'MANAGER'] });
const base = '/staff/outlets/o1/reviews';

const review = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  rating: 1,
  body: 'Terrible, call 98765 43210',
  feedback: { taste: null, portion: null, freshness: null, value: null },
  verifiedPurchase: true,
  author: 'Ravi K.',
  isMine: false,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
  edited: false,
  status: 'PUBLISHED',
  moderationReason: null,
  moderatedAt: null,
  item: { id: 'i1', name: 'Masala chai' },
  openReports: 2,
  reportReasons: ['PERSONAL_INFO'],
  ...overrides,
});

const summary = {
  average: 3.5,
  total: 4,
  distribution: [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: stars === 5 || stars === 2 ? 2 : 0,
  })),
  openReports: 1,
  trendWindowDays: 30,
  items: [
    {
      id: 'i1',
      name: 'Masala chai',
      average: 3.5,
      count: 4,
      recentAverage: 2,
      priorAverage: 5,
      trend: 'DECLINING',
    },
  ],
  recentFeedback: [
    { ...review(), body: 'Too sweet today', item: { id: 'i1', name: 'Masala chai' } },
  ],
};

describe('manager reviews', () => {
  it('shows outlet analytics and hides a reported review with a reason', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockApi({
      'GET /auth/me': signedInAs(manager),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      [`GET ${base}/summary`]: () => ({ status: 200, body: { summary } }),
      [`GET ${base}`]: () => ({
        status: 200,
        body: { reviews: [review()], page: 1, pageSize: 10, total: 1, hasMore: false },
      }),
      [`POST ${base}/r1/hide`]: (init) => {
        posts.push({ url: 'hide', body: JSON.parse(String(init.body)) });
        return { status: 200, body: { ok: true } };
      },
    });
    renderRoute('/manage/reviews');

    expect(await screen.findByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    expect(await screen.findByText('1 reported review needs a look')).toBeVisible();
    expect(screen.getByText('Declining')).toBeVisible();
    expect(screen.getByText('Too sweet today')).toBeVisible();

    expect(await screen.findByText('Terrible, call 98765 43210')).toBeVisible();
    expect(screen.getByText(/2 reports: Shares personal information/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide this review?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide review' }));
    expect(within(dialog).getByText('Say why the review is being hidden.')).toBeVisible();
    expect(posts).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Shares a phone number');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide review' }));
    await vi.waitFor(() =>
      expect(posts).toEqual([{ url: 'hide', body: { reason: 'Shares a phone number' } }]),
    );
    expect(await screen.findByText('Review hidden')).toBeVisible();
  });
});
