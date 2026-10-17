import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs, signedOut } from '@/test/api';
import { makeCart } from '@/test/commerce';
import { makeMenuItem, makeOutlet } from '@/test/outlets';
import type { OwnReview, Review } from '@/services/reviews';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ITEM = '/menu-items/i1';
const PAGE = '/outlets/night-owl-cafe/items/i1';

const distribution = (counts: [number, number, number, number, number]) =>
  [5, 4, 3, 2, 1].map((stars, i) => ({ stars, count: counts[i]! }));

function detail(rating: { average: number | null; count: number; distribution: unknown }) {
  return {
    status: 200,
    body: {
      item: { ...makeMenuItem(), rating },
      category: { id: 'c1', name: 'Hot drinks', sortOrder: 0 },
      outlet: makeOutlet(),
    },
  };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'r1',
    rating: 5,
    body: 'Best chai on campus',
    feedback: { taste: 'GREAT', portion: 'OKAY', freshness: null, value: null },
    verifiedPurchase: true,
    author: 'Ravi K.',
    isMine: false,
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
    edited: false,
    ...overrides,
  };
}

const page = (reviews: Review[], extra: object = {}) => ({
  status: 200,
  body: { reviews, page: 1, pageSize: 10, total: reviews.length, hasMore: false, ...extra },
});

const student = makeUser();

describe('dish page', () => {
  it('shows the real average, count, distribution and verified reviews', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      [`GET ${ITEM}`]: () =>
        detail({ average: 4.5, count: 2, distribution: distribution([1, 1, 0, 0, 0]) }),
      [`GET ${ITEM}/reviews`]: () =>
        page([makeReview(), makeReview({ id: 'r2', rating: 4, body: null, author: 'Meera S.' })]),
    });
    renderRoute(PAGE);
    expect(await screen.findByRole('heading', { name: 'Masala chai', level: 1 })).toBeVisible();
    expect(screen.getAllByText('Rated 4.5 out of 5 from 2 ratings').length).toBeGreaterThan(0);
    const bars = screen.getByRole('list', { name: 'Ratings by stars' });
    expect(within(bars).getAllByRole('listitem')).toHaveLength(5);
    expect(within(bars).getByText('5 stars')).toBeInTheDocument();

    expect(await screen.findByText('Best chai on campus')).toBeVisible();
    expect(screen.getAllByText('Verified Purchase')).toHaveLength(2);
    expect(screen.getAllByText('Taste: Great · Portion size: Just right')).toHaveLength(2);
    expect(screen.getByText(/Meera S\./)).toBeVisible();
    // Signed out: invited to sign in, no reporting.
    expect(screen.getByText('Ordered this? Sign in to rate it.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Report' })).not.toBeInTheDocument();
  });

  it('shows a clean empty state for an unrated dish', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      [`GET ${ITEM}`]: () =>
        detail({ average: null, count: 0, distribution: distribution([0, 0, 0, 0, 0]) }),
      [`GET ${ITEM}/reviews`]: () => page([]),
    });
    renderRoute(PAGE);
    expect(await screen.findByText('Be the first to rate this item')).toBeVisible();
    expect(screen.getAllByText('Not yet rated').length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'Ratings by stars' })).not.toBeInTheDocument();
  });

  it('loads more reviews on demand and re-sorts on the server', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedOut,
      [`GET ${ITEM}`]: () =>
        detail({ average: 4, count: 11, distribution: distribution([3, 5, 3, 0, 0]) }),
      [`GET ${ITEM}/reviews`]: (init) => {
        void init;
        const url = String(fetchMock.mock.lastCall?.[0]);
        const p = Number(new URL(url, 'http://x').searchParams.get('page'));
        return p === 1
          ? page(
              Array.from({ length: 10 }, (_, i) =>
                makeReview({ id: `r${i}`, body: `Review ${i}` }),
              ),
              { total: 11, hasMore: true },
            )
          : page([makeReview({ id: 'r10', body: 'Review 10' })], {
              page: 2,
              total: 11,
              hasMore: false,
            });
      },
    });
    renderRoute(PAGE);
    expect(await screen.findByText('Review 9')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Show more reviews' }));
    expect(await screen.findByText('Review 10')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show more reviews' })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Sort reviews'), 'highest');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('sort=highest&page=1'))).toBe(
        true,
      ),
    );
  });
});

describe('writing a review', () => {
  function signedIn(mine: { eligible: boolean; review: OwnReview | null }, posts: unknown[]) {
    return mockApi({
      'GET /auth/me': signedInAs(student),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      [`GET ${ITEM}`]: () =>
        detail({ average: null, count: 0, distribution: distribution([0, 0, 0, 0, 0]) }),
      [`GET ${ITEM}/reviews`]: () => page([]),
      [`GET ${ITEM}/my-review`]: () => ({ status: 200, body: mine }),
      [`POST ${ITEM}/reviews`]: (init) => {
        posts.push(JSON.parse(String(init.body)));
        return { status: 201, body: { review: {}, rating: {} } };
      },
      'PATCH /reviews/r1': (init) => {
        posts.push({ patch: JSON.parse(String(init.body)) });
        return { status: 200, body: { review: {} } };
      },
    });
  }

  it('lets an eligible student rate with stars, feedback and text', async () => {
    const posts: unknown[] = [];
    signedIn({ eligible: true, review: null }, posts);
    renderRoute(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Rate food' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rate this dish' });

    // Stars are required.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit review' }));
    expect(within(dialog).getByText('Choose 1 to 5 stars.')).toBeVisible();
    expect(posts).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('radio', { name: '4 stars: Good' }));
    const taste = within(dialog).getByRole('group', { name: 'Taste' });
    await userEvent.click(within(taste).getByRole('radio', { name: 'Great' }));
    const portion = within(dialog).getByRole('group', { name: 'Portion size' });
    await userEvent.click(within(portion).getByRole('radio', { name: 'Generous' }));
    await userEvent.type(within(dialog).getByLabelText(/Your review/), '  Lovely and hot  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit review' }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      rating: 4,
      body: 'Lovely and hot',
      taste: 'GREAT',
      portion: 'GREAT',
      freshness: null,
      value: null,
    });
    expect(await screen.findByText('Thanks for your review')).toBeVisible();
  });

  it('edits the existing review instead of creating another', async () => {
    const posts: unknown[] = [];
    signedIn(
      {
        eligible: true,
        review: {
          ...makeReview({ isMine: true, author: 'Asha' }),
          status: 'PUBLISHED',
          moderationReason: null,
        },
      },
      posts,
    );
    renderRoute(PAGE);
    expect(await screen.findByText('Best chai on campus')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Rate food' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit your review' });
    expect(within(dialog).getByRole('radio', { name: '5 stars: Excellent' })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('radio', { name: '2 stars: Poor' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ patch: { rating: 2, body: 'Best chai on campus' } });
  });

  it('explains when the student hasn’t collected this dish', async () => {
    signedIn({ eligible: false, review: null }, []);
    renderRoute(PAGE);
    expect(
      await screen.findByText('You can rate this dish after you’ve collected an order with it.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Rate food' })).not.toBeInTheDocument();
  });

  it('shows the server’s refusal in the form', async () => {
    mockApi({
      'GET /auth/me': signedInAs(student),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
      [`GET ${ITEM}`]: () =>
        detail({ average: null, count: 0, distribution: distribution([0, 0, 0, 0, 0]) }),
      [`GET ${ITEM}/reviews`]: () => page([]),
      [`GET ${ITEM}/my-review`]: () => ({ status: 200, body: { eligible: true, review: null } }),
      [`POST ${ITEM}/reviews`]: () => ({
        status: 409,
        body: { error: { code: 'REVIEW_EXISTS', message: 'You’ve already reviewed this dish.' } },
      }),
    });
    renderRoute(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Rate food' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rate this dish' });
    await userEvent.click(within(dialog).getByRole('radio', { name: '3 stars: Average' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit review' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You’ve already reviewed this dish.',
    );
  });
});

describe('menu ratings', () => {
  it('shows real ratings or "Not yet rated" on each dish, and can sort by rating', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets/night-owl-cafe/menu': () => ({
        status: 200,
        body: {
          outlet: makeOutlet(),
          categories: [{ id: 'c1', name: 'Hot drinks', sortOrder: 0 }],
          items: [
            makeMenuItem({ rating: { average: 4.6, count: 128 } }),
            makeMenuItem({ id: 'i2', name: 'Filter coffee' }),
          ],
        },
      }),
    });
    renderRoute('/outlets/night-owl-cafe');
    const rated = await screen.findByRole('link', {
      name: 'Rated 4.6 out of 5 from 128 ratings. See reviews',
    });
    expect(rated).toHaveAttribute('href', '/outlets/night-owl-cafe/items/i1');
    expect(rated).toHaveTextContent('4.6·128 ratings');
    expect(screen.getByRole('link', { name: 'Not yet rated. See reviews' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Highest Rated' }));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('sort=highest-rated'))).toBe(
        true,
      ),
    );
  });
});
