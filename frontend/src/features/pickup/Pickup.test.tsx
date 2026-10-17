import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart, makeOrder } from '@/test/commerce';
import { outletRow, staffSummary } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const student = makeUser();
const cashier = makeUser({ roles: ['STUDENT', 'POS'] });

function studentOrder(status: string, pickup: object, extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /auth/me': signedInAs(student),
    'GET /cart': () => ({ status: 200, body: { cart: makeCart({ items: [] }) } }),
    'GET /orders/ord1': () => ({
      status: 200,
      body: { order: makeOrder({ status: status as never }) },
    }),
    'GET /orders/ord1/pickup': () => ({ status: 200, body: { pickup } }),
    ...extra,
  });
}

describe('student pickup code', () => {
  it('explains the code comes when the order is ready', async () => {
    studentOrder('PREPARING', { state: 'NOT_READY' });
    renderRoute('/orders/ord1');
    expect(
      await screen.findByText('Your pickup code will appear here when your order is ready.'),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: /Pickup QR code/ })).not.toBeInTheDocument();
  });

  it('shows the QR and numeric code with instructions, validity and a warning when ready', async () => {
    studentOrder('READY', {
      state: 'ACTIVE',
      code: '480213',
      qrPayload: `CCPICKUP1.${'a'.repeat(43)}`,
      expiresAt: '2026-10-17T16:00:00.000Z',
      paymentDuePaise: 0,
    });
    renderRoute('/orders/ord1');
    const panel = await screen.findByRole('region', { name: 'Ready for pickup' });
    expect(
      await within(panel).findByRole('img', { name: 'Pickup QR code for order N-007' }),
    ).toBeVisible();
    expect(within(panel).getByLabelText('Pickup code 4 8 0 2 1 3')).toHaveTextContent('480 213');
    expect(
      within(panel).getByText(/Show this code to the serving staff when collecting your order/),
    ).toBeVisible();
    expect(within(panel).getByText(/Valid until/)).toBeVisible();
    expect(within(panel).getByText(/Don’t share this code/)).toBeVisible();
    // The order number is labelled as such, not as the pickup code.
    expect(screen.getByText('Order number')).toBeVisible();
  });

  it('lets the student get a new code after it expired', async () => {
    const refreshes: string[] = [];
    studentOrder(
      'READY',
      { state: 'EXPIRED', canRefresh: true },
      {
        'POST /orders/ord1/pickup/refresh': () => {
          refreshes.push('x');
          return {
            status: 200,
            body: {
              pickup: {
                state: 'ACTIVE',
                code: '702915',
                qrPayload: `CCPICKUP1.${'b'.repeat(43)}`,
                expiresAt: '2026-10-17T16:00:00.000Z',
                paymentDuePaise: 0,
              },
            },
          };
        },
      },
    );
    renderRoute('/orders/ord1');
    await userEvent.click(await screen.findByRole('button', { name: 'Get a new code' }));
    await vi.waitFor(() => expect(refreshes).toHaveLength(1));
  });

  it('shows ORDER COLLECTED with the time, and no code, after handover', async () => {
    studentOrder('COMPLETED', { state: 'COLLECTED', collectedAt: '2026-10-17T07:05:00.000Z' });
    renderRoute('/orders/ord1');
    const panel = await screen.findByRole('region', { name: 'Order collected' });
    expect(within(panel).getByText(/Handed over at/)).toBeVisible();
    expect(screen.queryByText(/Pickup code/)).not.toBeInTheDocument();
  });
});

describe('staff verify pickup', () => {
  const verified = (extra: object = {}) => ({
    challengeToken: 'c'.repeat(43),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    canConfirm: true,
    order: {
      id: 'ord1',
      pickupCode: 'N-007',
      status: 'READY',
      timing: 'IMMEDIATE',
      scheduledFor: null,
      customer: { displayName: 'Asha' },
      items: [{ menuItemId: 'i1', name: 'Masala chai', quantity: 2 }],
      paymentMethod: 'WALLET',
      paymentDuePaise: 0,
    },
    ...extra,
  });

  function pos(handlers: Parameters<typeof mockApi>[0]) {
    return mockApi({
      'GET /auth/me': signedInAs(cashier),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow(['POS'])] } }),
      'GET /staff/outlets/o1/orders': () => ({
        status: 200,
        body: {
          orders: [staffSummary({ status: 'READY', paymentStatus: 'PAID' })],
          nextCursor: null,
        },
      }),
      ...handlers,
    });
  }

  it('checks the code, shows the matched order, and hands over only on explicit confirmation', async () => {
    const calls: { url: string; body: unknown }[] = [];
    pos({
      'POST /staff/outlets/o1/pickup/verify': (init) => {
        calls.push({ url: 'verify', body: JSON.parse(String(init.body)) });
        return { status: 200, body: verified() };
      },
      'POST /staff/outlets/o1/pickup/confirm': (init) => {
        calls.push({ url: 'confirm', body: JSON.parse(String(init.body)) });
        return {
          status: 200,
          body: {
            order: makeOrder({ status: 'COMPLETED' }),
            alreadyConfirmed: false,
            handover: {
              handedOverAt: new Date().toISOString(),
              handedOverBy: 'Cash',
              method: 'CODE',
            },
          },
        };
      },
    });
    renderRoute('/pos');
    // READY tickets offer verification, not a one-click hand over.
    const queue = await screen.findByRole('list', { name: 'Order queue' });
    expect(within(queue).queryByRole('button', { name: 'Hand over' })).not.toBeInTheDocument();
    await userEvent.click(within(queue).getByRole('button', { name: 'Verify pickup' }));

    const dialog = await screen.findByRole('dialog', { name: 'Verify pickup' });
    const input = within(dialog).getByLabelText('Student’s pickup code');
    await userEvent.type(input, '48a213');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify code' }));
    expect(within(dialog).getByText('Use digits only.')).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, '4802');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify code' }));
    expect(within(dialog).getByText('Pickup codes are 6 digits.')).toBeVisible();
    expect(calls).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.type(input, '480 213');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify code' }));
    expect(await within(dialog).findByText('N-007')).toBeVisible();
    expect(within(dialog).getByText('Asha')).toBeVisible();
    expect(
      within(within(dialog).getByRole('list', { name: 'Items' })).getByText('Masala chai'),
    ).toBeVisible();
    // Verifying alone handed nothing over.
    expect(calls).toEqual([{ url: 'verify', body: { method: 'CODE', code: '480213' } }]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm handover' }));
    expect(await within(dialog).findByText(/N-007 handed over at/)).toBeVisible();
    expect(calls[1]).toEqual({ url: 'confirm', body: { challengeToken: 'c'.repeat(43) } });
  });

  it('shows how many tries are left after a wrong code', async () => {
    pos({
      'POST /staff/outlets/o1/pickup/verify': () => ({
        status: 404,
        body: {
          error: {
            code: 'PICKUP_NO_MATCH',
            message: 'No ready order at this outlet matches that code. Check it with the student.',
            details: { attemptsLeft: 3 },
          },
        },
      }),
    });
    renderRoute('/pos');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Verify pickup', hidden: false }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Verify pickup' });
    await userEvent.type(within(dialog).getByLabelText('Student’s pickup code'), '111222');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify code' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No ready order at this outlet matches that code. Check it with the student. 3 tries left before a short cooldown.',
    );
  });

  it('blocks the handover until a counter payment is recorded', async () => {
    pos({
      'POST /staff/outlets/o1/pickup/verify': () => ({
        status: 200,
        body: verified({
          canConfirm: false,
          order: { ...verified().order, paymentMethod: 'COUNTER', paymentDuePaise: 4000 },
        }),
      }),
    });
    renderRoute('/pos');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Verify pickup' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Verify pickup' });
    await userEvent.type(within(dialog).getByLabelText('Student’s pickup code'), '480213');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify code' }));
    expect(await within(dialog).findByText(/Take ₹40 at the counter first/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Confirm handover' })).toBeDisabled();
  });

  it('asks for the camera only when staff start scanning, and falls back when it is blocked', async () => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    pos({});
    renderRoute('/pos');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Verify pickup' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Verify pickup' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scan QR' }));
    expect(getUserMedia).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start camera' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Camera access is blocked/);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
