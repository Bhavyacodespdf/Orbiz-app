import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeWallet } from '@/test/commerce';
import type { Group } from '@/services/groups';
import type { Split } from '@/services/splits';
import type { Booking } from '@/services/banquets';

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = makeUser({ id: 'u1', displayName: 'Asha', email: 'asha@example.com' });

function member(
  id: string,
  name: string,
  role: 'HOST' | 'MEMBER',
  items: { name: string; qty: number; price: number }[] = [],
) {
  return {
    id,
    userId: `user-${id}`,
    displayName: name,
    avatarUrl: null,
    role,
    joinedAt: '2026-10-17T05:00:00.000Z',
    percentBps: null,
    customAmountPaise: null,
    items: items.map((i, n) => ({
      id: `${id}-${n}`,
      memberId: id,
      menuItemId: `item-${i.name}`,
      name: i.name,
      unitPricePaise: i.price,
      quantity: i.qty,
      lineTotalPaise: i.price * i.qty,
      problem: null,
    })),
    itemsTotalPaise: items.reduce((a, i) => a + i.price * i.qty, 0),
  };
}

function group(overrides: Partial<Group> = {}): Group {
  return {
    id: 'g1',
    code: 'ABCDEFGH23',
    name: 'Project lunch',
    description: '',
    status: 'ACTIVE',
    outlet: {
      id: 'o1',
      name: 'Night Owl Café',
      slug: 'night-owl-cafe',
      status: 'OPEN',
      isActive: true,
    },
    host: { id: 'user-m1', displayName: 'Asha' },
    maxMembers: 8,
    joinClosesAt: null,
    allocationMode: 'BY_DISH',
    version: 3,
    createdAt: '2026-10-17T05:00:00.000Z',
    checkoutAt: null,
    orderedAt: null,
    cancelledAt: null,
    cancelReason: null,
    order: null,
    me: { memberId: 'm1', role: 'HOST' },
    members: [
      member('m1', 'Asha', 'HOST', [{ name: 'Chai', qty: 2, price: 2000 }]),
      member('m2', 'Ravi', 'MEMBER', [{ name: 'Puff', qty: 1, price: 3500 }]),
    ],
    tray: { subtotalPaise: 7500, totalPaise: 7500, itemCount: 3, problems: [] },
    allocationPreview: {
      ok: true,
      amounts: [
        { id: 'm1', amountPaise: 4000 },
        { id: 'm2', amountPaise: 3500 },
      ],
    },
    settlement: null,
    events: [],
    ...overrides,
  };
}

const menu = {
  outlet: {
    id: 'o1',
    slug: 'night-owl-cafe',
    name: 'Night Owl Café',
    description: '',
    location: '',
    imageUrl: null,
    status: 'OPEN',
    acceptingOrders: true,
    isSample: false,
  },
  categories: [{ id: 'c1', name: 'Snacks', sortOrder: 0 }],
  items: [
    {
      id: 'item-Chai',
      categoryId: 'c1',
      name: 'Chai',
      description: '',
      pricePaise: 2000,
      dietary: 'VEG',
      isAvailable: true,
      stockStatus: 'AVAILABLE',
      rating: { average: null, count: 0 },
      imageUrl: null,
    },
    {
      id: 'item-Samosa',
      categoryId: 'c1',
      name: 'Samosa',
      description: '',
      pricePaise: 1500,
      dietary: 'VEG',
      isAvailable: false,
      stockStatus: 'SOLD_OUT',
      rating: { average: null, count: 0 },
      imageUrl: null,
    },
  ],
};

type Handler = Parameters<typeof mockApi>[0][string];
const api = (extra: Record<string, Handler> = {}) =>
  mockApi({
    'GET /auth/me': signedInAs(me),
    'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(10_000) } }),
    'GET /outlets/night-owl-cafe/menu': () => ({ status: 200, body: menu }),
    ...extra,
  });
const sent = (fetchMock: ReturnType<typeof api>, path: string, method: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === `/api/v1${path}` && init?.method === method,
  );

describe('Group Repast & Splits page', () => {
  it('shows the heading, three tabs, and joins with a code', async () => {
    const fetchMock = api({
      'GET /groups': () => ({
        status: 200,
        body: {
          groups: [
            {
              id: 'g1',
              name: 'Project lunch',
              outlet: 'Night Owl Café',
              status: 'CHECKOUT',
              role: 'MEMBER',
              memberCount: 3,
              myShare: { amountDuePaise: 3500, status: 'UNPAID' },
              createdAt: '2026-10-17T05:00:00.000Z',
            },
          ],
        },
      }),
      'POST /groups/join': () => ({ status: 200, body: { group: group() } }),
      'GET /groups/g1': () => ({ status: 200, body: { group: group() } }),
    });
    const { router } = renderRoute('/groups');
    expect(
      await screen.findByRole('heading', { name: /Group repast & splits/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Collaborative dining')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Group Tray',
      'Banquet',
      'Splits',
    ]);
    expect(screen.getByRole('tab', { name: 'Group Tray' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const card = await screen.findByText('Project lunch');
    expect(card.closest('a')).toHaveTextContent('Your share: ₹35');
    expect(card.closest('a')).toHaveTextContent('Unpaid');

    await userEvent.click(screen.getByRole('button', { name: 'Join code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Join a group' });
    await userEvent.type(within(dialog).getByLabelText('Join code'), 'abcde-fgh23');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Join group' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/tray/g1'));
    expect(JSON.parse(String(sent(fetchMock, '/groups/join', 'POST')[0]![1]!.body))).toEqual({
      code: 'abcde-fgh23',
    });
  });
});

describe('group tray', () => {
  it('shows members, contributions and allocated amounts, and validates percentages before saving', async () => {
    const fetchMock = api({
      'GET /groups/g1': () => ({ status: 200, body: { group: group() } }),
      'PUT /groups/g1/allocation': () => ({
        status: 200,
        body: { group: group({ allocationMode: 'PERCENTAGE' }) },
      }),
    });
    renderRoute('/groups/tray/g1');
    expect(await screen.findByText('ABCDE-FGH23')).toBeInTheDocument();
    const members = screen.getByRole('heading', { name: 'Members (2/8)' }).closest('div')!;
    expect(within(members).getByText('2 × Chai · ₹40')).toBeInTheDocument();
    expect(
      within(members)
        .getAllByText(/Pays/)
        .map((p) => p.textContent),
    ).toEqual(['Pays ₹40', 'Pays ₹35']);

    await userEvent.click(screen.getByRole('radio', { name: /Percentage/ }));
    await userEvent.type(screen.getByLabelText('Asha (%)'), '60');
    await userEvent.type(screen.getByLabelText('Ravi (%)'), '30');
    expect(screen.getByText('Adds up to 90.00% of 100%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save formula' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Ravi (%)'));
    await userEvent.type(screen.getByLabelText('Ravi (%)'), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Save formula' }));
    await waitFor(() =>
      expect(
        JSON.parse(String(sent(fetchMock, '/groups/g1/allocation', 'PUT')[0]![1]!.body)),
      ).toEqual({
        mode: 'PERCENTAGE',
        percents: { m1: 6000, m2: 4000 },
      }),
    );
    // A sold-out dish can't be added.
    expect(screen.getByRole('button', { name: 'One more Samosa' })).toBeDisabled();
  });

  it('asks the host to confirm each person’s amount before locking the tray', async () => {
    const fetchMock = api({
      'GET /groups/g1': () => ({ status: 200, body: { group: group() } }),
      'POST /groups/g1/checkout': () => ({
        status: 200,
        body: { group: group({ status: 'CHECKOUT' }) },
      }),
    });
    renderRoute('/groups/tray/g1');
    await userEvent.click(await screen.findByRole('button', { name: 'Group checkout · ₹75' }));
    const dialog = await screen.findByRole('dialog', { name: /Lock the tray/ });
    expect(within(dialog).getByText('Asha').closest('li')).toHaveTextContent('₹40');
    expect(within(dialog).getByText('Ravi').closest('li')).toHaveTextContent('₹35');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm ₹75' }));
    await waitFor(() =>
      expect(
        JSON.parse(String(sent(fetchMock, '/groups/g1/checkout', 'POST')[0]![1]!.body)),
      ).toEqual({ expectedTotalPaise: 7500 }),
    );
  });

  it('lets a member pay their own share once, with a retry-safe key', async () => {
    const checkout = group({
      status: 'CHECKOUT',
      me: { memberId: 'm2', role: 'MEMBER' },
      settlement: {
        id: 's1',
        version: 1,
        status: 'OPEN',
        mode: 'BY_DISH',
        subtotalPaise: 7500,
        totalPaise: 7500,
        createdAt: '2026-10-17T05:00:00.000Z',
        lines: [],
        shares: [
          {
            id: 'sh1',
            memberId: 'm1',
            userId: 'user-m1',
            displayName: 'Asha',
            amountDuePaise: 4000,
            ownItemsPaise: 4000,
            amountPaidPaise: 4000,
            outstandingPaise: 0,
            status: 'PAID',
            method: 'WALLET',
            transactionId: null,
            paidAt: '2026-10-17T05:01:00.000Z',
            refundedAt: null,
          },
          {
            id: 'sh2',
            memberId: 'm2',
            userId: 'user-m2',
            displayName: 'Ravi',
            amountDuePaise: 3500,
            ownItemsPaise: 3500,
            amountPaidPaise: 0,
            outstandingPaise: 3500,
            status: 'UNPAID',
            method: null,
            transactionId: null,
            paidAt: null,
            refundedAt: null,
          },
        ],
      },
    });
    const fetchMock = api({
      'GET /groups/g1': () => ({ status: 200, body: { group: checkout } }),
      'POST /groups/g1/shares/mine/pay': () => ({
        status: 201,
        body: { group: { ...checkout, status: 'ORDERED' }, orderError: null },
      }),
    });
    renderRoute('/groups/tray/g1');
    expect(await screen.findByText(/This is a payment to CampusCart/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add|One more/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Pay ₹35 from wallet' }));
    await waitFor(() =>
      expect(sent(fetchMock, '/groups/g1/shares/mine/pay', 'POST')).toHaveLength(1),
    );
    const init = sent(fetchMock, '/groups/g1/shares/mine/pay', 'POST')[0]![1]!;
    expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^cc-/);
  });
});

function split(overrides: Partial<Split> = {}): Split {
  return {
    id: 'sp1',
    title: 'Canteen dinner',
    description: '',
    totalPaise: 1000,
    currency: 'INR',
    method: 'EQUAL',
    status: 'OPEN',
    expenseDate: '2026-10-16',
    dueDate: null,
    owner: { id: 'u2', displayName: 'Meera' },
    isOwner: false,
    participants: [
      {
        id: 'p0',
        userId: 'u2',
        displayName: 'Meera',
        avatarUrl: null,
        amountDuePaise: 334,
        amountPaidPaise: 0,
        outstandingPaise: 0,
        status: 'OWNER',
      },
      {
        id: 'p1',
        userId: 'u1',
        displayName: 'Asha',
        avatarUrl: null,
        amountDuePaise: 333,
        amountPaidPaise: 100,
        outstandingPaise: 233,
        status: 'PARTIALLY_PAID',
      },
    ],
    myShare: {
      amountDuePaise: 333,
      amountPaidPaise: 100,
      outstandingPaise: 233,
      status: 'PARTIALLY_PAID',
    },
    totalOutstandingPaise: 233,
    cancelledAt: null,
    cancelReason: null,
    createdAt: '2026-10-16T05:00:00.000Z',
    updatedAt: '2026-10-16T05:00:00.000Z',
    ...overrides,
  };
}

describe('peer splits', () => {
  it('labels whose amount is whose and settles only what is owed through the wallet', async () => {
    const fetchMock = api({
      'GET /splits': () => ({
        status: 200,
        body: {
          splits: [
            split(),
            split({
              id: 'sp2',
              title: 'Movie snacks',
              status: 'SETTLED',
              myShare: {
                amountDuePaise: 200,
                amountPaidPaise: 200,
                outstandingPaise: 0,
                status: 'PAID',
              },
            }),
          ],
        },
      }),
      'POST /splits/sp1/settlements': () => ({
        status: 201,
        body: { split: split({ status: 'SETTLED' }) },
      }),
    });
    renderRoute('/groups?tab=splits');
    const card = (await screen.findByRole('heading', { name: 'Canteen dinner' })).closest('li')!;
    expect(card).toHaveTextContent('₹10 in total · paid by Meera');
    expect(card).toHaveTextContent('Your share ₹3.33 · you’ve paid ₹1 · you owe ₹2.33');
    const settled = screen.getByRole('heading', { name: 'Movie snacks' }).closest('li')!;
    expect(within(settled).queryByRole('button', { name: 'Settle via wallet' })).toBeNull();
    expect(within(settled).getAllByText('Settled').length).toBeGreaterThan(0);

    await userEvent.click(within(card).getByRole('button', { name: 'Settle via wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Repay Meera' });
    const amount = within(dialog).getByLabelText(/Amount/);
    expect(amount).toHaveValue('2.33');
    await userEvent.clear(amount);
    await userEvent.type(amount, '5');
    expect(within(dialog).getByRole('button', { name: /Pay/ })).toBeDisabled(); // more than owed
    await userEvent.clear(amount);
    await userEvent.type(amount, '2.33');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pay ₹2.33' }));
    await waitFor(() => expect(sent(fetchMock, '/splits/sp1/settlements', 'POST')).toHaveLength(1));
    const init = sent(fetchMock, '/splits/sp1/settlements', 'POST')[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ amountPaise: 233 });
    expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^cc-/);
  });
});

const booking: Booking = {
  id: 'b1',
  name: 'ML club meetup',
  eventType: 'CLUB_EVENT',
  status: 'CONFIRMED',
  outlet: { id: 'o1', name: 'Night Owl Café', location: 'Library block' },
  host: 'Asha',
  startsAt: '2026-10-22T06:30:00.000Z',
  endsAt: '2026-10-22T08:30:00.000Z',
  guestCount: 10,
  dietaryNotes: '',
  instructions: '',
  contactPhone: null,
  estimatedTotalPaise: 55_000,
  perGuestPaise: 5500,
  items: [
    {
      menuItemId: 'i1',
      name: 'Paneer Tikka Wrap',
      unitPricePaise: 5500,
      quantity: 4,
      lineTotalPaise: 22_000,
    },
  ],
  decisionReason: null,
  decidedAt: null,
  history: [],
  createdAt: '2026-10-17T05:00:00.000Z',
};

describe('banquets', () => {
  it('shows persisted bookings with their package and the event pass', async () => {
    api({
      'GET /banquets': () => ({ status: 200, body: { bookings: [booking] } }),
      'GET /banquets/b1/pass': () => ({
        status: 200,
        body: { booking: { ...booking, passToken: 'tok_abcdefghijklmnopqrstuvwxyz012345' } },
      }),
    });
    const { router } = renderRoute('/groups?tab=banquet');
    expect(await screen.findByRole('heading', { name: 'ML club meetup' })).toBeInTheDocument();
    expect(screen.getByText('Paneer Tikka Wrap (x4)')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText(/about ₹55 per guest/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'View event pass' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/groups/banquets/b1/pass'));
    expect(await screen.findByLabelText('Pass code')).toHaveTextContent(
      'tok_abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(screen.getByText(/Show this code at the counter/)).toBeInTheDocument();
  });
});
