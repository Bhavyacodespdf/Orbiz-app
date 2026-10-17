import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { outletRow, staffDetail, staffSummary } from '@/test/staff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const manager = makeUser({ roles: ['STUDENT', 'MANAGER'] });

describe('manager order board', () => {
  it('says so when the manager has no outlet yet', async () => {
    mockApi({
      'GET /auth/me': signedInAs(manager),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [] } }),
    });
    renderRoute('/manage');
    expect(await screen.findByText('You’re not assigned to an outlet yet')).toBeInTheDocument();
  });

  it('puts each order in its status column', async () => {
    mockApi({
      'GET /auth/me': signedInAs(manager),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/orders': () => ({
        status: 200,
        body: {
          orders: [
            staffSummary(),
            staffSummary({
              id: 'ord2',
              pickupCode: 'N-008',
              status: 'READY',
              paymentMethod: 'WALLET',
              paymentStatus: 'PAID',
            }),
          ],
        },
      }),
    });
    renderRoute('/manage');
    const placed = await screen.findByRole('region', { name: 'New' });
    expect(await within(placed).findByText('N-007')).toBeInTheDocument();
    expect(within(placed).getByText('Collect ₹40')).toBeInTheDocument();
    const ready = screen.getByRole('region', { name: 'Ready for pickup' });
    expect(within(ready).getByText('N-008')).toBeInTheDocument();
    expect(within(ready).getByText('Paid · wallet')).toBeInTheDocument();
  });

  it('opens an order and only lets the manager reject with a reason', async () => {
    const posts: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(manager),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/orders': () => ({ status: 200, body: { orders: [staffSummary()] } }),
      'GET /staff/outlets/o1/orders/ord1': () => ({ status: 200, body: { order: staffDetail() } }),
      'POST /staff/outlets/o1/orders/ord1/transition': (init) => {
        posts.push(JSON.parse(String(init.body)));
        return { status: 200, body: { order: staffDetail({ status: 'REJECTED' }) } };
      },
    });
    renderRoute('/manage');
    await userEvent.click(await screen.findByRole('button', { name: /^Open order N-007/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Order N-007' });
    expect(within(dialog).getByRole('button', { name: 'Accept' })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm: Reject' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the student a reason');
    expect(posts).toEqual([]);

    await userEvent.type(within(dialog).getByLabelText(/Reason for the student/), 'Out of milk');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm: Reject' }));
    await vi.waitFor(() => expect(posts).toEqual([{ to: 'REJECTED', reason: 'Out of milk' }]));
  });

  it('lets staff mark a packaged line of a scheduled order as not resellable, with a reason', async () => {
    const posts: unknown[] = [];
    const scheduledDetail = (unsuitable: boolean) =>
      staffDetail({
        status: 'READY',
        timing: 'SCHEDULED',
        scheduledFor: '2099-01-01T08:00:00.000Z',
        pickupDeadline: '2099-01-01T08:10:00.000Z',
        scheduledFeePaise: 1000,
        allowedNextStatuses: ['COMPLETED'],
        items: [
          {
            menuItemId: 'i1',
            name: 'Veg puff',
            unitPricePaise: 3500,
            quantity: 2,
            lineTotalPaise: 7000,
            fulfillmentType: 'PACKAGED',
            unsuitableForResale: unsuitable,
            noShow: null,
          },
          {
            menuItemId: 'i2',
            name: 'Masala chai',
            unitPricePaise: 2000,
            quantity: 1,
            lineTotalPaise: 2000,
            fulfillmentType: 'HANDMADE',
            unsuitableForResale: false,
            noShow: null,
          },
        ],
      });
    let flagged = false;
    mockApi({
      'GET /auth/me': signedInAs(manager),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [outletRow()] } }),
      'GET /staff/outlets/o1/orders': () => ({ status: 200, body: { orders: [staffSummary()] } }),
      'GET /staff/outlets/o1/orders/ord1': () => ({
        status: 200,
        body: { order: scheduledDetail(flagged) },
      }),
      'POST /staff/outlets/o1/orders/ord1/items/i1/not-resellable': (init) => {
        posts.push(JSON.parse(String(init.body)));
        flagged = true;
        return { status: 200, body: { order: scheduledDetail(true) } };
      },
    });
    renderRoute('/manage');
    await userEvent.click(await screen.findByRole('button', { name: /^Open order N-007/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Order N-007' });
    expect(within(dialog).getByText('Packaged')).toBeInTheDocument();
    expect(within(dialog).getByText('Handmade')).toBeInTheDocument();
    expect(within(dialog).getByText(/Collect by/)).toBeInTheDocument();
    // Only the packaged line can be flagged.
    const flags = within(dialog).getAllByRole('button', { name: 'Mark not resellable' });
    expect(flags).toHaveLength(1);
    await userEvent.click(flags[0]!);
    const confirm = within(dialog).getAllByRole('button', { name: 'Mark not resellable' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/be resold/), 'Packet torn');
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(posts).toEqual([{ reason: 'Packet torn' }]));
    expect(
      await within(dialog).findByText(/Not resellable — won’t be restocked/),
    ).toBeInTheDocument();
  });
});
