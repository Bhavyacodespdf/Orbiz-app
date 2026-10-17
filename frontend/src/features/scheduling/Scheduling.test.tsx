import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart, makeOrder, makeWallet } from '@/test/commerce';
import { outletRow, staffSummary } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const iso = (local: string) => new Date(`${local}+05:30`).toISOString();
const slotsBody = (
  days = [
    {
      date: '2030-01-10',
      hours: { opensMinute: 540, closesMinute: 1260 },
      slots: [
        { startsAt: iso('2030-01-10T12:00:00'), label: '12:00 pm', available: true },
        { startsAt: iso('2030-01-10T12:15:00'), label: '12:15 pm', available: false },
        { startsAt: iso('2030-01-10T12:30:00'), label: '12:30 pm', available: true },
      ],
    },
  ],
) => ({ timezone: 'Asia/Kolkata', feePaise: 1000, leadMinutes: 30, slotMinutes: 15, days });

type Handler = Parameters<typeof mockApi>[0][string];

function checkoutApi(extra: Record<string, Handler> = {}, cart = makeCart()) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser()),
    'GET /cart': () => ({ status: 200, body: { cart } }),
    'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(50_000) } }),
    'GET /outlets/night-owl-cafe/slots': () => ({ status: 200, body: slotsBody() }),
    'POST /orders': () => ({ status: 201, body: { order: makeOrder() } }),
    'GET /orders/ord1': () => ({ status: 200, body: { order: makeOrder() } }),
    ...extra,
  });
}
const orderBodies = (fetchMock: ReturnType<typeof checkoutApi>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === '/api/v1/orders' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)));

describe('scheduling at checkout', () => {
  it('orders now exactly as before: no fee, no time', async () => {
    const fetchMock = checkoutApi();
    renderRoute('/checkout');
    expect(await screen.findByRole('radio', { name: /Order now/ })).toBeChecked();
    expect(screen.queryByText('Scheduled-order fee')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Pay from wallet · ₹40' }));
    await waitFor(() =>
      expect(orderBodies(fetchMock)).toEqual([
        { paymentMethod: 'WALLET', expectedTotalPaise: 4000, pointsToRedeem: 0 },
      ]),
    );
  });

  it('shows the ₹10 fee once and the chosen time before placing a scheduled order', async () => {
    const fetchMock = checkoutApi();
    renderRoute('/checkout');
    await userEvent.click(await screen.findByRole('radio', { name: /Schedule for later/ }));
    expect(screen.getByRole('button', { name: /Schedule · Pay from wallet/ })).toBeDisabled(); // no time yet

    const time = await screen.findByLabelText('Pickup time');
    expect(within(time).getByRole('option', { name: '12:15 pm (full)' })).toBeDisabled();
    await userEvent.selectOptions(time, iso('2030-01-10T12:30:00'));
    expect(screen.getByText(/Pickup: Thu, 10 Jan, 12:30 pm \(IST\)/)).toBeInTheDocument();
    expect(screen.getByText('Food subtotal')).toBeInTheDocument();
    expect(screen.getByText('Scheduled-order fee')).toBeInTheDocument();
    expect(screen.getByText('₹10')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Schedule · Pay from wallet · ₹50' }));
    await waitFor(() =>
      expect(orderBodies(fetchMock)).toEqual([
        {
          paymentMethod: 'WALLET',
          expectedTotalPaise: 5000,
          pointsToRedeem: 0,
          scheduledFor: iso('2030-01-10T12:30:00'),
        },
      ]),
    );
  });

  it('explains when no slots are left and won’t submit', async () => {
    checkoutApi({
      'GET /outlets/night-owl-cafe/slots': () => ({ status: 200, body: slotsBody([]) }),
    });
    renderRoute('/checkout');
    await userEvent.click(await screen.findByRole('radio', { name: /Schedule for later/ }));
    expect(await screen.findByText(/no pickup slots left to book/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Schedule · / })).toBeDisabled();
  });

  it('only offers scheduling while the outlet is closed right now', async () => {
    checkoutApi({}, makeCart({ canCheckout: false, canSchedule: true }));
    renderRoute('/checkout');
    expect(await screen.findByRole('radio', { name: /Order now/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Schedule for later/ })).toBeChecked();
    expect(
      screen.getByText(/isn’t taking orders right now, but you can schedule/),
    ).toBeInTheDocument();
  });

  it('asks for another time when the slot was taken meanwhile', async () => {
    checkoutApi({
      'POST /orders': () => ({
        status: 409,
        body: { error: { code: 'SLOT_FULL', message: 'That pickup slot is full.' } },
      }),
    });
    renderRoute('/checkout');
    await userEvent.click(await screen.findByRole('radio', { name: /Schedule for later/ }));
    await userEvent.selectOptions(
      await screen.findByLabelText('Pickup time'),
      iso('2030-01-10T12:00:00'),
    );
    await userEvent.click(screen.getByRole('button', { name: /Schedule · Pay from wallet/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That pickup slot is full. Please choose another pickup time.',
    );
    expect(screen.getByLabelText('Pickup time')).toHaveValue('');
  });
});

describe('scheduled orders after placing', () => {
  const scheduled = makeOrder({
    timing: 'SCHEDULED',
    scheduledFor: iso('2030-01-10T12:00:00'),
    scheduledFeePaise: 1000,
    totalPaise: 5000,
    refundPaise: 4000,
  });

  it('says before cancelling that the ₹10 fee isn’t refunded', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({ status: 200, body: { order: scheduled } }),
    });
    renderRoute('/orders/ord1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      '₹40 will be returned to your wallet straight away. The ₹10 scheduled-order fee isn’t refunded.',
    );
  });

  it('shows the pickup time and the fee, and lets the student change the time', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({ status: 200, body: { order: scheduled } }),
      'GET /outlets/night-owl-cafe/slots': () => ({ status: 200, body: slotsBody() }),
      'POST /orders/ord1/reschedule': () => ({
        status: 200,
        body: { order: { ...scheduled, scheduledFor: iso('2030-01-10T12:30:00'), version: 2 } },
      }),
    });
    renderRoute('/orders/ord1');
    expect(await screen.findByText('Order scheduled')).toBeInTheDocument();
    expect(screen.getByText('Thu, 10 Jan, 12:00 pm')).toBeInTheDocument();
    expect(screen.getByText('Scheduled-order fee')).toBeInTheDocument();
    expect(screen.getByText('Total paid')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Change time' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change pickup time' });
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Pickup time'),
      iso('2030-01-10T12:30:00'),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save new time' }));
    expect(await screen.findByText('Pickup time changed')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/reschedule'))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ scheduledFor: iso('2030-01-10T12:30:00') });
  });
});

describe('staff', () => {
  it('marks scheduled orders on the board and filters the queue on the server', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER'] })),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/orders': () => ({
        status: 200,
        body: {
          orders: [
            staffSummary({
              timing: 'SCHEDULED',
              scheduledFor: iso('2030-01-10T12:00:00'),
              scheduledFeePaise: 1000,
              totalPaise: 5000,
            }),
          ],
          nextCursor: null,
        },
      }),
    });
    renderRoute('/manage');
    const card = await screen.findByRole('article', { name: 'Order N-007' });
    expect(card).toHaveTextContent('Scheduled · Thu, 10 Jan, 12:00 pm');
    await userEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
    await userEvent.click(screen.getByRole('button', { name: 'Past due' }));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toContain(
      '/api/v1/staff/outlets/o1/orders?view=active&limit=100&timing=SCHEDULED',
    );
    expect(urls).toContain('/api/v1/staff/outlets/o1/orders?view=active&limit=100&due=past_due');
  });

  it('lets the manager set pickup hours', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER'] })),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/schedule': () => ({
        status: 200,
        body: {
          schedule: {
            leadMinutes: 30,
            slotMinutes: 15,
            daysAhead: 2,
            slotCapacity: null,
            hours: [],
          },
        },
      }),
      'PUT /staff/outlets/o1/schedule': (init) => ({
        status: 200,
        body: { schedule: JSON.parse(String(init.body)) },
      }),
    });
    renderRoute('/manage/outlet');
    const panel = await screen.findByRole('region', { name: 'Scheduled orders' });
    await userEvent.click(await within(panel).findByRole('checkbox', { name: 'Monday' }));
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Sunday' }));
    const sundayCloses = within(panel).getByLabelText('Sunday closes');
    await userEvent.clear(sundayCloses);
    await userEvent.type(sundayCloses, '00:00');
    await userEvent.type(within(panel).getByLabelText('Orders per slot (blank = no limit)'), '8');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save pickup hours' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(call![1]!.body))).toEqual({
        leadMinutes: 30,
        slotMinutes: 15,
        daysAhead: 2,
        slotCapacity: 8,
        hours: [
          { weekday: 1, opensMinute: 540, closesMinute: 1260 },
          { weekday: 0, opensMinute: 540, closesMinute: 1440 },
        ],
      });
    });
  });
});
