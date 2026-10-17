import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { outletRow, staffDetail, staffSummary } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const cashier = makeUser({ roles: ['STUDENT', 'POS'] });

describe('POS queue', () => {
  it('moves an order forward with one tap', async () => {
    const posts: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(cashier),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow(['POS'])] } }),
      'GET /staff/outlets/o1/orders': () => ({ status: 200, body: { orders: [staffSummary()] } }),
      'POST /staff/outlets/o1/orders/ord1/transition': (init) => {
        posts.push(JSON.parse(String(init.body)));
        return { status: 200, body: {} };
      },
    });
    renderRoute('/pos');
    const ticket = await screen.findByRole('article', { name: 'Order N-007' });
    await userEvent.click(within(ticket).getByRole('button', { name: 'Accept' }));
    await vi.waitFor(() => expect(posts).toEqual([{ to: 'ACCEPTED' }]));
  });

  it('takes counter payment only after an explicit "received" confirmation', async () => {
    const payments: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(cashier),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow(['POS'])] } }),
      'GET /staff/outlets/o1/orders': () => ({
        status: 200,
        body: { orders: [staffSummary({ status: 'READY' })] },
      }),
      'GET /staff/outlets/o1/orders/ord1': () => ({
        status: 200,
        body: {
          order: staffDetail({
            status: 'READY',
            allowedNextStatuses: [],
            canRecordPayment: true,
          }),
        },
      }),
      'POST /staff/outlets/o1/orders/ord1/counter-payment': (init) => {
        payments.push(JSON.parse(String(init.body)));
        return { status: 200, body: {} };
      },
    });
    renderRoute('/pos');
    await userEvent.click(await screen.findByRole('button', { name: 'Take ₹40' }));
    const dialog = await screen.findByRole('dialog', { name: 'Order N-007' });
    // No one-click hand over: the student's pickup code must be verified (after payment).
    expect(within(dialog).queryByRole('button', { name: 'Hand over' })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Record the counter payment first/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Verify pickup' })).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Record counter payment' }));
    expect(payments).toEqual([]);
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Only confirm once you have actually received ₹40',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm ₹40 received' }));
    await vi.waitFor(() => expect(payments).toEqual([{ amountPaise: 4000 }]));
  });

  it('finds an order by pickup code', async () => {
    mockApi({
      'GET /auth/me': signedInAs(cashier),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow(['POS'])] } }),
      'GET /staff/outlets/o1/orders': () => ({
        status: 200,
        body: { orders: [staffSummary(), staffSummary({ id: 'ord2', pickupCode: 'N-012' })] },
      }),
    });
    renderRoute('/pos');
    await screen.findByRole('article', { name: 'Order N-007' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find by pickup code' }), 'n012');
    expect(screen.queryByRole('article', { name: 'Order N-007' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Order N-012' })).toBeInTheDocument();
  });
});
