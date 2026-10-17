import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { outletRow } from '@/test/staff';
import { makeDish, makeManagerPoll } from '@/test/polls';
import type { ManagerPoll } from '@/services/polls';

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  categoryId: 'c1',
  name,
  description: '',
  pricePaise: 9000,
  dietary: 'VEG',
  isAvailable: true,
  imageUrl: null,
  isActive: true,
  sortOrder: 0,
  stockStatus: extra.isAvailable === false ? 'SOLD_OUT' : 'AVAILABLE',
  soldOutManually: extra.isAvailable === false,
  fulfillmentType: null,
  trackInventory: false,
  stockQuantity: null,
  lowStockThreshold: 0,
  stockUpdatedAt: null,
  ...extra,
});

const menu = {
  outlet: { ...outletRow().outlet, isActive: true },
  categories: [{ id: 'c1', name: 'Mains', sortOrder: 0, isActive: true }],
  items: [
    item('i1', 'Paneer Wrap'),
    item('i2', 'Veg Burger'),
    item('i3', 'Thali', { isAvailable: false }),
    item('i4', 'Retired Dish', { isActive: false }),
  ],
};

type Handlers = Parameters<typeof mockApi>[0];

function setup(polls: ManagerPoll[], extra: Handlers = {}, roles = ['STUDENT', 'MANAGER']) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser({ roles: roles as never })),
    'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
    'GET /staff/outlets/o1/menu': () => ({ status: 200, body: menu }),
    'GET /staff/outlets/o1/polls': () => ({ status: 200, body: { polls, nextBefore: null } }),
    ...extra,
  });
}

const bodyOf = (fetchMock: ReturnType<typeof setup>, path: string) => {
  const call = fetchMock.mock.calls.find(
    (c) => String(c[0]) === `/api/v1${path}` && (c[1]?.method ?? 'GET') !== 'GET',
  );
  return call ? JSON.parse(String(call[1]!.body ?? 'null')) : undefined;
};

const card = (name = /Special for/) => screen.findByRole('region', { name });

describe('Today’s Special management', () => {
  it('is in the manager navigation and explains the empty state', async () => {
    setup([]);
    renderRoute('/manage/specials');
    expect(await screen.findByText('No polls yet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Specials' })[0]).toHaveAttribute(
      'href',
      '/manage/specials',
    );
  });

  it('creates a draft with chosen dishes and IST times; unavailable dishes can’t be picked', async () => {
    const fetchMock = setup([], {
      'POST /staff/outlets/o1/polls': () => ({ status: 201, body: { poll: makeManagerPoll() } }),
    });
    renderRoute('/manage/specials');
    await userEvent.click(await screen.findByRole('button', { name: 'New poll' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Today’s Special poll' });

    expect(within(dialog).queryByText('Retired Dish')).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: /Thali/ })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Paneer Wrap/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose between 2 and 10 dishes.',
    );
    expect(bodyOf(fetchMock, '/staff/outlets/o1/polls')).toBeUndefined();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Veg Burger/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(bodyOf(fetchMock, '/staff/outlets/o1/polls')).toBeDefined());
    const body = bodyOf(fetchMock, '/staff/outlets/o1/polls');
    expect(body).toEqual({
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      opensAt: `${body.day}T10:00:00+05:30`,
      closesAt: `${body.day}T12:00:00+05:30`,
      menuItemIds: ['i1', 'i2'],
      showLiveResults: false,
    });
    expect(await screen.findByText('Draft poll created')).toBeInTheDocument();
  });

  it('shows the server’s reason when a draft is refused', async () => {
    setup([], {
      'POST /staff/outlets/o1/polls': () => ({
        status: 409,
        body: {
          error: { code: 'POLL_EXISTS', message: 'This outlet already has a poll for that date.' },
        },
      }),
    });
    renderRoute('/manage/specials');
    await userEvent.click(await screen.findByRole('button', { name: 'New poll' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Paneer Wrap/ }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Veg Burger/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This outlet already has a poll for that date.',
    );
  });

  it('previews a draft and opens voting after confirmation', async () => {
    const fetchMock = setup([makeManagerPoll()], {
      'POST /staff/outlets/o1/polls/p1/open': () => ({
        status: 200,
        body: { poll: makeManagerPoll({ status: 'OPEN', phase: 'VOTING' }) },
      }),
    });
    renderRoute('/manage/specials');
    const draft = await card();
    expect(within(draft).getByText('Draft')).toBeInTheDocument();
    expect(within(draft).getByText('Paneer Wrap')).toBeInTheDocument();
    expect(within(draft).getByText('Veg Burger')).toBeInTheDocument();

    await userEvent.click(within(draft).getByRole('button', { name: 'Open voting' }));
    const confirm = await screen.findByRole('dialog', { name: 'Open voting?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Open voting' }));

    await waitFor(() => expect(bodyOf(fetchMock, '/staff/outlets/o1/polls/p1/open')).toEqual({}));
    expect(await screen.findByText('Voting is open')).toBeInTheDocument();
  });

  it('deletes a draft only after confirmation', async () => {
    const fetchMock = setup([makeManagerPoll()], {
      'DELETE /staff/outlets/o1/polls/p1': () => ({ status: 204 }),
    });
    renderRoute('/manage/specials');
    await userEvent.click(within(await card()).getByRole('button', { name: 'Delete draft' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this draft?' });
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete draft' }));
    expect(await screen.findByText('Draft deleted')).toBeInTheDocument();
  });

  it('shows live counts while voting and can close early', async () => {
    const voting = makeManagerPoll({
      status: 'OPEN',
      phase: 'VOTING',
      votesCast: 5,
      options: [
        { id: 'opt1', dish: makeDish(), votable: true, counted: true, votes: 3, percentage: 60 },
        {
          id: 'opt2',
          dish: makeDish({ id: 'i2', name: 'Veg Burger' }),
          votable: true,
          counted: true,
          votes: 2,
          percentage: 40,
        },
      ],
    });
    const fetchMock = setup([voting], {
      'POST /staff/outlets/o1/polls/p1/close': () => ({
        status: 200,
        body: {
          poll: {
            ...voting,
            status: 'FINALIZED',
            phase: 'FINALIZED',
            result: {
              outcome: 'WINNER',
              winnerOptionId: 'opt1',
              totalVotes: 5,
              winnerVotes: 3,
              winnerPercentage: 60,
              finalizedAt: voting.serverNow,
            },
          },
        },
      }),
    });
    renderRoute('/manage/specials');
    const live = await card();
    expect(within(live).getByText('Voting open')).toBeInTheDocument();
    expect(within(live).getByText('3 votes')).toBeInTheDocument();
    expect(within(live).getByText('60%')).toBeInTheDocument();
    expect(within(live).queryByRole('button', { name: 'Edit' })).toBeNull();

    await userEvent.click(within(live).getByRole('button', { name: 'Close voting now' }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Close voting now?' })).getByRole('button', {
        name: 'Close voting',
      }),
    );
    await waitFor(() => expect(bodyOf(fetchMock, '/staff/outlets/o1/polls/p1/close')).toEqual({}));
    expect(await screen.findByText('Voting closed and the result is in')).toBeInTheDocument();
  });

  it('resolves a tie by choosing only among the tied dishes', async () => {
    const tied = makeManagerPoll({
      status: 'CLOSED',
      phase: 'CLOSED',
      votesCast: 5,
      tiedOptionIds: ['opt1', 'opt2'],
      options: [
        { id: 'opt1', dish: makeDish(), votable: true, counted: true, votes: 2, percentage: 40 },
        {
          id: 'opt2',
          dish: makeDish({ id: 'i2', name: 'Veg Burger' }),
          votable: true,
          counted: true,
          votes: 2,
          percentage: 40,
        },
        {
          id: 'opt3',
          dish: makeDish({ id: 'i3', name: 'Pasta' }),
          votable: true,
          counted: true,
          votes: 1,
          percentage: 20,
        },
      ],
    });
    const fetchMock = setup([tied], {
      'POST /staff/outlets/o1/polls/p1/finalize': () => ({
        status: 200,
        body: {
          poll: {
            ...tied,
            status: 'FINALIZED',
            phase: 'FINALIZED',
            tiedOptionIds: null,
            result: {
              outcome: 'TIE_RESOLVED_BY_MANAGER',
              winnerOptionId: 'opt2',
              totalVotes: 5,
              winnerVotes: 2,
              winnerPercentage: 40,
              finalizedAt: tied.serverNow,
            },
          },
        },
      }),
    });
    renderRoute('/manage/specials');
    const pending = await card();
    expect(within(pending).getByText('Tie — needs your choice')).toBeInTheDocument();
    expect(within(pending).getAllByRole('radio')).toHaveLength(2);
    expect(within(pending).queryByRole('radio', { name: 'Choose Pasta' })).toBeNull();

    const confirmButton = within(pending).getByRole('button', {
      name: 'Make chosen dish the special',
    });
    expect(confirmButton).toBeDisabled();
    await userEvent.click(within(pending).getByRole('radio', { name: 'Choose Veg Burger' }));
    await userEvent.click(confirmButton);
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Make this dish the special?' })).getByRole(
        'button',
        { name: 'Confirm special' },
      ),
    );
    await waitFor(() =>
      expect(bodyOf(fetchMock, '/staff/outlets/o1/polls/p1/finalize')).toEqual({
        tieBreakOptionId: 'opt2',
      }),
    );
    expect(await screen.findByText('Today’s Special confirmed')).toBeInTheDocument();
  });

  it('shows past results, including a poll nobody voted in', async () => {
    setup([
      makeManagerPoll({
        id: 'p2',
        day: '2026-10-15',
        status: 'FINALIZED',
        phase: 'FINALIZED',
        votesCast: 85,
        options: [
          {
            id: 'opt1',
            dish: makeDish(),
            votable: true,
            counted: true,
            votes: 42,
            percentage: 49.4,
          },
          {
            id: 'opt2',
            dish: makeDish({ id: 'i2', name: 'Veg Burger' }),
            votable: true,
            counted: true,
            votes: 43,
            percentage: 50.6,
          },
        ],
        result: {
          outcome: 'WINNER',
          winnerOptionId: 'opt2',
          totalVotes: 85,
          winnerVotes: 43,
          winnerPercentage: 50.6,
          finalizedAt: '2026-10-15T07:00:00.000Z',
        },
      }),
      makeManagerPoll({
        id: 'p3',
        day: '2026-10-14',
        status: 'FINALIZED',
        phase: 'FINALIZED',
        result: {
          outcome: 'NO_VOTES',
          winnerOptionId: null,
          totalVotes: 0,
          winnerVotes: null,
          winnerPercentage: null,
          finalizedAt: '2026-10-14T07:00:00.000Z',
        },
      }),
    ]);
    renderRoute('/manage/specials');
    const won = await card(/15 Oct/);
    expect(within(won).getByText(/is the\s+special/)).toHaveTextContent(
      'Veg Burger is the special. Won with 43 of 85 votes (50.6%).',
    );
    const empty = await card(/14 Oct/);
    expect(
      within(empty).getByText('Nobody voted, so there is no special for this day.'),
    ).toBeInTheDocument();
    expect(within(empty).queryByRole('button')).toBeNull();
  });

  it('tells POS-only staff they are not assigned as a manager', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'POS', 'MANAGER'] })),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow(['POS'])] } }),
    });
    renderRoute('/manage/specials');
    expect(await screen.findByText('You’re not assigned to an outlet yet')).toBeInTheDocument();
  });
});
