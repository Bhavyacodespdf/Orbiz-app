import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs, signedOut } from '@/test/api';
import { makeMenuItem, makeOutlet } from '@/test/outlets';
import { emptyCart } from '@/test/commerce';
import { makeDish, makeOption, makePoll, makeSpecial } from '@/test/polls';
import type { StudentPoll } from '@/services/polls';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Handlers = Parameters<typeof mockApi>[0];

/** The outlet page with a signed-in student and whatever poll/special the test needs. */
function outletApi(options: {
  poll?: StudentPoll | null;
  special?: ReturnType<typeof makeSpecial> | null;
  signedIn?: boolean;
  extra?: Handlers;
}) {
  return mockApi({
    'GET /auth/me': options.signedIn === false ? signedOut : signedInAs(makeUser()),
    'GET /outlets/night-owl-cafe/menu': () => ({
      status: 200,
      body: {
        outlet: makeOutlet(),
        categories: [{ id: 'c1', name: 'Mains', sortOrder: 0 }],
        items: [makeMenuItem()],
      },
    }),
    'GET /outlets/night-owl-cafe/special': () => ({
      status: 200,
      body: { day: '2026-10-16', special: options.special ?? null },
    }),
    'GET /outlets/night-owl-cafe/poll': () => ({
      status: 200,
      body: { poll: options.poll ?? null },
    }),
    'GET /cart': () => ({ status: 200, body: { cart: emptyCart() } }),
    ...options.extra,
  });
}

const pollRegion = () => screen.findByRole('region', { name: /special/i });

describe('voting for Today’s Special', () => {
  it('asks signed-out visitors to sign in and never requests the poll', async () => {
    const fetchMock = outletApi({ signedIn: false });
    renderRoute('/outlets/night-owl-cafe');
    const link = await screen.findByRole('link', { name: 'Sign in to vote' });
    expect(link).toHaveAttribute('href', '/login?returnTo=%2Foutlets%2Fnight-owl-cafe');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(
      '/api/v1/outlets/night-owl-cafe/poll',
    );
  });

  it('shows the dishes, the closing time, and hides counts while voting', async () => {
    outletApi({ poll: makePoll() });
    renderRoute('/outlets/night-owl-cafe');
    const region = await screen.findByRole('region', { name: 'Vote for today’s special' });

    expect(within(region).getByText(/Voting closes in 42 min \(12:12 pm\)/)).toBeInTheDocument();
    const dishes = within(region).getByRole('list', { name: 'Dishes in this vote' });
    expect(within(dishes).getByText('Paneer Wrap')).toBeInTheDocument();
    expect(within(dishes).getByText('₹90')).toBeInTheDocument();
    expect(within(dishes).getByText('Snacks')).toBeInTheDocument();
    expect(
      within(region).getByText('Vote counts are revealed when voting closes.'),
    ).toBeInTheDocument();
    expect(within(region).queryByText(/^\d+ votes?$/)).not.toBeInTheDocument();
  });

  it('sends only the chosen option, then shows the server-confirmed vote', async () => {
    const fetchMock = outletApi({
      poll: makePoll(),
      extra: {
        'POST /polls/p1/vote': () => ({
          status: 200,
          body: { poll: makePoll({ myOptionId: 'opt2' }) },
        }),
      },
    });
    renderRoute('/outlets/night-owl-cafe');
    await userEvent.click(await screen.findByRole('button', { name: 'Vote for Veg Burger' }));

    const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/v1/polls/p1/vote')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ optionId: 'opt2' });

    const region = await pollRegion();
    expect(
      await within(region).findByText(/You can change it until voting closes/),
    ).toBeInTheDocument();
    expect(within(region).getByRole('status')).toHaveTextContent('Your vote: Veg Burger.');
    expect(within(region).getByRole('button', { name: 'Vote for Paneer Wrap' })).toBeEnabled();
    expect(within(region).queryByRole('button', { name: 'Vote for Veg Burger' })).toBeNull();
    expect(await screen.findByText('You voted for Veg Burger.')).toBeInTheDocument();
  });

  it('explains a refused vote and re-reads the poll', async () => {
    let reads = 0;
    outletApi({
      extra: {
        'GET /outlets/night-owl-cafe/poll': () => {
          reads += 1;
          return {
            status: 200,
            body: {
              poll:
                reads === 1
                  ? makePoll()
                  : makePoll({
                      phase: 'CLOSED',
                      resultsVisible: true,
                      votesCast: 0,
                      options: makePoll().options.map((o) => ({ ...o, votes: 0, percentage: 0 })),
                    }),
            },
          };
        },
        'POST /polls/p1/vote': () => ({
          status: 409,
          body: { error: { code: 'POLL_CLOSED', message: 'Voting has closed for this poll.' } },
        }),
      },
    });
    renderRoute('/outlets/night-owl-cafe');
    await userEvent.click(await screen.findByRole('button', { name: 'Vote for Paneer Wrap' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your vote wasn’t saved');
    expect(alert).toHaveTextContent('Voting has closed for this poll.');
    expect(
      await screen.findByText('Voting has closed. Waiting for the outlet to confirm the result.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vote for/ })).toBeNull();
  });

  it('does not offer a vote for an unavailable dish', async () => {
    outletApi({
      poll: makePoll({
        options: [
          makeOption(),
          makeOption({
            id: 'opt2',
            votable: false,
            dish: makeDish({ id: 'i2', name: 'Thali', isAvailable: false, orderable: false }),
          }),
        ],
      }),
    });
    renderRoute('/outlets/night-owl-cafe');
    expect(await screen.findByRole('button', { name: 'Vote for Thali' })).toBeDisabled();
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });

  it('shows when voting opens for an upcoming poll', async () => {
    outletApi({
      poll: makePoll({
        phase: 'UPCOMING',
        opensAt: '2026-10-16T07:30:00.000Z',
        closesAt: '2026-10-16T09:00:00.000Z',
      }),
    });
    renderRoute('/outlets/night-owl-cafe');
    expect(await screen.findByText('Voting opens 1:00 pm.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vote for/ })).toBeNull();
  });

  it('says so when there is no poll, and shows an error with retry when it fails', async () => {
    outletApi({ poll: null });
    const { unmount } = renderRoute('/outlets/night-owl-cafe');
    expect(
      await screen.findByText('No Today’s Special vote is running at this outlet right now.'),
    ).toBeInTheDocument();
    unmount();

    outletApi({
      extra: {
        'GET /outlets/night-owl-cafe/poll': () => ({
          status: 500,
          body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
        }),
      },
    });
    renderRoute('/outlets/night-owl-cafe');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load the Today’s Special vote');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('results and Today’s Special', () => {
  const finalized = makePoll({
    phase: 'FINALIZED',
    resultsVisible: true,
    votesCast: 85,
    myOptionId: 'opt2',
    options: [
      makeOption({ votes: 42, percentage: 49.4 }),
      makeOption({
        id: 'opt2',
        votes: 43,
        percentage: 50.6,
        dish: makeDish({ id: 'i2', name: 'Veg Burger' }),
      }),
    ],
    result: {
      outcome: 'WINNER',
      winnerOptionId: 'opt1',
      totalVotes: 85,
      winnerVotes: 42,
      winnerPercentage: 49.4,
      finalizedAt: '2026-10-16T06:42:00.000Z',
    },
  });

  it('shows server counts, percentages and the winner, plus the special banner', async () => {
    outletApi({ poll: finalized, special: makeSpecial() });
    renderRoute('/outlets/night-owl-cafe');

    const banner = await screen.findByRole('region', { name: 'Paneer Wrap' });
    expect(within(banner).getByText('Today’s Special')).toBeInTheDocument();
    expect(within(banner).getByText('Won with 42 of 85 votes (49.4%)')).toBeInTheDocument();
    expect(within(banner).getByText('₹90')).toBeInTheDocument();

    const results = await screen.findByRole('region', { name: 'Results: today’s special' });
    const items = within(results).getAllByRole('listitem');
    expect(within(items[0]!).getByText('42 votes')).toBeInTheDocument();
    expect(within(items[0]!).getByText('49.4%')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Today’s Special')).toBeInTheDocument();
    expect(within(items[1]!).queryByText('Today’s Special')).toBeNull();
    expect(within(results).getByRole('status')).toHaveTextContent('Your vote: Veg Burger.');
    expect(within(results).queryByRole('button', { name: /Vote for/ })).toBeNull();
  });

  it('discloses a tie resolved by the manager', async () => {
    outletApi({
      poll: { ...finalized, result: { ...finalized.result!, outcome: 'TIE_RESOLVED_BY_MANAGER' } },
      special: makeSpecial({ outcome: 'TIE_RESOLVED_BY_MANAGER', winnerVotes: 12, totalVotes: 30 }),
    });
    renderRoute('/outlets/night-owl-cafe');
    expect(
      await screen.findByText('Tied at 12 votes — chosen by the outlet manager'),
    ).toBeInTheDocument();
    expect(screen.getByText(/the outlet manager chose between them/)).toBeInTheDocument();
  });

  it('never shows a winner when nobody voted', async () => {
    outletApi({
      poll: makePoll({
        phase: 'FINALIZED',
        resultsVisible: true,
        votesCast: 0,
        options: makePoll().options.map((o) => ({ ...o, votes: 0, percentage: 0 })),
        result: {
          outcome: 'NO_VOTES',
          winnerOptionId: null,
          totalVotes: 0,
          winnerVotes: null,
          winnerPercentage: null,
          finalizedAt: '2026-10-16T06:42:00.000Z',
        },
      }),
      special: null,
    });
    renderRoute('/outlets/night-owl-cafe');
    expect(await screen.findByText(/Nobody voted, so this poll has no winner/)).toBeInTheDocument();
    expect(screen.queryByText('Today’s Special')).toBeNull();
  });
});

describe('home page specials', () => {
  function homeApi(specials: ReturnType<typeof makeSpecial>[]) {
    return mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets': () => ({ status: 200, body: { outlets: [makeOutlet()] } }),
      'GET /specials': () => ({ status: 200, body: { day: '2026-10-16', specials } }),
    });
  }

  it('features each outlet’s special and links to the outlet', async () => {
    homeApi([makeSpecial()]);
    renderRoute('/');
    const section = await screen.findByRole('region', { name: 'Today’s specials' });
    const link = within(section).getByRole('link', {
      name: 'Paneer Wrap, today’s special at Night Owl Café',
    });
    expect(link).toHaveAttribute('href', '/outlets/night-owl-cafe');
    expect(within(link).getByText('₹90')).toBeInTheDocument();
    expect(within(link).getByText('Won with 42 of 85 votes (49.4%)')).toBeInTheDocument();
  });

  it('shows nothing when no outlet has a special today', async () => {
    homeApi([]);
    renderRoute('/');
    await screen.findByText('Night Owl Café');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Today’s specials' })).toBeNull(),
    );
  });
});
