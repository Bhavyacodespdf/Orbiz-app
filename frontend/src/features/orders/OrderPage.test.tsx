import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeOrder } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<OrderPage />', () => {
  it('shows the pickup code, snapshot items and a paid-from-wallet label', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({ status: 200, body: { order: makeOrder() } }),
    });
    renderRoute('/orders/ord1');
    expect(await screen.findByText('N-007')).toBeInTheDocument();
    expect(screen.getByText('2 × Masala chai')).toBeInTheDocument();
    expect(screen.getByText('Paid from wallet (simulated test funds)')).toBeInTheDocument();
  });

  it('is honest that a counter order is not paid yet, and when live updates are off', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({
        status: 200,
        body: { order: makeOrder({ paymentMethod: 'COUNTER', paymentStatus: 'PENDING_COUNTER' }) },
      }),
    });
    renderRoute('/orders/ord1');
    expect(await screen.findByText(/not paid yet/)).toBeInTheDocument();
    expect(screen.getByText('Live updates off')).toBeInTheDocument();
    expect(screen.getByText(/Not receiving live updates right now/)).toBeInTheDocument();
  });

  it('shows not found for an order that is not yours', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/other': () => ({
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Order not found' } },
      }),
    });
    renderRoute('/orders/other');
    expect(await screen.findByText('Order not found')).toBeInTheDocument();
  });

  it('shows progress for an in-flight order', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({
        status: 200,
        body: { order: makeOrder({ status: 'PREPARING' }) },
      }),
    });
    renderRoute('/orders/ord1');
    const progress = await screen.findByRole('list', { name: 'Order progress' });
    expect(within(progress).getByText('Preparing').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
  });

  it('lets the student cancel a PLACED order after confirming, and shows the refund', async () => {
    let order = makeOrder();
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({ status: 200, body: { order } }),
      'POST /orders/ord1/cancel': () => {
        order = makeOrder({ status: 'CANCELLED', paymentStatus: 'REFUNDED', version: 2 });
        return { status: 200, body: { order } };
      },
    });
    renderRoute('/orders/ord1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this order?' });
    expect(dialog).toHaveTextContent('₹40 will be returned to your wallet');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText('This order was cancelled.')).toBeInTheDocument();
    expect(screen.getByText('₹40 refunded to your wallet (simulated funds)')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('shows why an order was rejected', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({
        status: 200,
        body: {
          order: makeOrder({
            status: 'REJECTED',
            paymentStatus: 'REFUNDED',
            cancelReason: 'Out of milk',
          }),
        },
      }),
    });
    renderRoute('/orders/ord1');
    expect(await screen.findByText(/couldn’t take this order/)).toHaveTextContent(
      'Reason: “Out of milk”',
    );
  });

  describe('scheduled-order no-show policy', () => {
    const scheduled = {
      timing: 'SCHEDULED' as const,
      scheduledFor: '2026-10-16T08:00:00.000Z',
      scheduledFeePaise: 1000,
      totalPaise: 5000,
    };

    it('shows the collect-by time before the grace period ends', async () => {
      mockApi({
        'GET /auth/me': signedInAs(makeUser()),
        'GET /orders/ord1': () => ({
          status: 200,
          body: {
            order: makeOrder({
              ...scheduled,
              status: 'READY',
              pickupDeadline: '2099-01-01T08:10:00.000Z',
            }),
          },
        }),
      });
      renderRoute('/orders/ord1');
      expect(await screen.findByText(/Collect by/)).toBeInTheDocument();
      expect(screen.queryByText(/no-show policy/)).not.toBeInTheDocument();
    });

    it('says the policy is pending without claiming a refund', async () => {
      mockApi({
        'GET /auth/me': signedInAs(makeUser()),
        'GET /orders/ord1': () => ({
          status: 200,
          body: {
            order: makeOrder({
              ...scheduled,
              status: 'READY',
              pickupDeadline: '2026-10-16T08:10:00.000Z',
            }),
          },
        }),
      });
      renderRoute('/orders/ord1');
      expect(await screen.findByText(/no-show policy is being applied/)).toBeInTheDocument();
      expect(screen.queryByText(/refunded to the CampusCart wallet/)).not.toBeInTheDocument();
    });

    it('shows the per-item outcome once the server has settled it', async () => {
      mockApi({
        'GET /auth/me': signedInAs(makeUser()),
        'GET /orders/ord1': () => ({
          status: 200,
          body: {
            order: makeOrder({
              ...scheduled,
              status: 'NO_SHOW',
              paymentStatus: 'PARTIALLY_REFUNDED',
              pickupDeadline: '2026-10-16T08:10:00.000Z',
              subtotalPaise: 7000,
              totalPaise: 8000,
              items: [
                {
                  menuItemId: 'i1',
                  name: 'Veg puff',
                  unitPricePaise: 3500,
                  quantity: 2,
                  lineTotalPaise: 7000,
                  fulfillmentType: 'PACKAGED',
                  unsuitableForResale: false,
                  noShow: {
                    paidPaise: 7000,
                    refundPaise: 6300,
                    feePaise: 700,
                    restockedQuantity: 2,
                  },
                },
                {
                  menuItemId: 'i2',
                  name: 'Masala chai',
                  unitPricePaise: 2000,
                  quantity: 1,
                  lineTotalPaise: 2000,
                  fulfillmentType: 'HANDMADE',
                  unsuitableForResale: false,
                  noShow: { paidPaise: 2000, refundPaise: 0, feePaise: 0, restockedQuantity: 0 },
                },
              ],
              noShow: {
                status: 'PROCESSED',
                processedAt: '2026-10-16T08:11:00.000Z',
                refundPaise: 6300,
                convenienceFeePaise: 700,
                scheduledFeeRetainedPaise: 1000,
                restockedUnits: 2,
              },
            }),
          },
        }),
      });
      renderRoute('/orders/ord1');
      const outcome = await screen.findByRole('region', { name: /no-show policy applied/ });
      expect(
        within(outcome).getByText(/₹63(\.00)? refunded · ₹7(\.00)? convenience fee/),
      ).toBeInTheDocument();
      expect(within(outcome).getByText('No refund — made to order.')).toBeInTheDocument();
      expect(within(outcome).getByText(/scheduled-order fee is kept/)).toBeInTheDocument();
      // Students never see restock details.
      expect(within(outcome).queryByText(/restocked/)).not.toBeInTheDocument();
    });
  });
});
