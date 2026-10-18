import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart, makeOrder, makeWallet } from '@/test/commerce';
import type { LoyaltyTransaction } from '@/services/wallet';

afterEach(() => {
  vi.unstubAllGlobals();
});

const pointsRow = (overrides: Partial<LoyaltyTransaction> = {}): LoyaltyTransaction => ({
  id: 'l1',
  type: 'EARNED_RECHARGE',
  direction: 'CREDIT',
  points: 25,
  pointsBalanceAfter: 25,
  rechargeId: 'r1',
  orderId: null,
  description: 'Bonus for a ₹1000 recharge (test mode)',
  isSimulated: true,
  createdAt: '2026-10-16T08:00:00.000Z',
  ...overrides,
});

function walletApi(pointsBalance: number, rows: LoyaltyTransaction[] = []) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser()),
    'GET /wallet': () => ({
      status: 200,
      body: { wallet: makeWallet(100000, true, pointsBalance) },
    }),
    'GET /wallet/transactions': () => ({
      status: 200,
      body: { transactions: [], nextCursor: null },
    }),
    'GET /wallet/points': () => ({
      status: 200,
      body: { pointsBalance, transactions: rows, nextCursor: null },
    }),
  });
}

describe('loyalty points on the wallet page', () => {
  it('shows points apart from money, with their rupee value', async () => {
    walletApi(25);
    renderRoute('/wallet');
    const money = await screen.findByRole('region', { name: 'Available balance' });
    const points = screen.getByRole('region', { name: 'Loyalty points' });
    expect(money).toHaveTextContent('₹1,000');
    expect(points).toHaveTextContent('25 points');
    expect(points).toHaveTextContent('Worth ₹25 off your orders');
    expect(points).toHaveTextContent('Points aren’t cash');
  });

  it('offers the minimum and the bonus amounts, marking only real bonuses', async () => {
    walletApi(0);
    renderRoute('/wallet');
    const quick = await screen.findByRole('group', { name: 'Quick amounts' });
    // The accessible name is the visible text, so speech and screen readers agree.
    for (const name of [
      '₹99',
      '₹500 +10 points',
      '₹1,000 +25 points',
      '₹1,300 +30 points',
      '₹1,500 +40 points',
    ]) {
      expect(within(quick).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(quick).getAllByRole('button')).toHaveLength(5);
    expect(screen.getByText(/Minimum ₹99/)).toBeInTheDocument();
  });

  it('previews no bonus for amounts that are not slabs, never a rounded one', async () => {
    walletApi(0);
    renderRoute('/wallet');
    const amount = await screen.findByLabelText('Amount');
    await userEvent.type(amount, '1400');
    expect(screen.getByText(/No bonus points for this amount/)).toBeInTheDocument();
    await userEvent.clear(amount);
    await userEvent.type(amount, '99');
    expect(screen.getByText(/No bonus points for this amount/)).toBeInTheDocument();
    await userEvent.clear(amount);
    await userEvent.type(amount, '1300');
    expect(
      screen.getByText('You’ll earn 30 points (worth ₹30) once this recharge succeeds.'),
    ).toBeInTheDocument();
  });

  it('lists points earned, used and returned', async () => {
    walletApi(15, [
      pointsRow({
        id: 'l3',
        type: 'RESTORED_ORDER',
        points: 10,
        pointsBalanceAfter: 15,
        rechargeId: null,
        orderId: 'ord1',
        description: 'Points returned: order N-007 was cancelled',
      }),
      pointsRow({
        id: 'l2',
        type: 'REDEEMED_ORDER',
        direction: 'DEBIT',
        points: 10,
        pointsBalanceAfter: 5,
        rechargeId: null,
        orderId: 'ord1',
        description: '₹10 off order N-007 at Night Owl Café',
      }),
      pointsRow(),
    ]);
    renderRoute('/wallet');
    const list = await screen.findByRole('list', { name: 'Points activity' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Returned (order cancelled)');
    expect(rows[0]).toHaveTextContent('+10 points');
    expect(rows[1]).toHaveTextContent('Used at checkout');
    expect(rows[1]).toHaveTextContent('−10 points');
    expect(rows[2]).toHaveTextContent('Recharge bonus');
    expect(rows[2]).toHaveTextContent('+25 points');
  });
});

describe('redeeming points at checkout', () => {
  function checkoutApi(options: {
    balancePaise: number;
    points: number;
    maxPoints: number;
    placeOrder?: (init: RequestInit) => { status: number; body?: unknown };
  }) {
    return mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({
        status: 200,
        body: {
          cart: makeCart({
            loyalty: {
              availablePoints: options.points,
              maxRedeemablePoints: options.maxPoints,
              pointValuePaise: 100,
            },
          }),
        },
      }),
      'GET /wallet': () => ({
        status: 200,
        body: { wallet: makeWallet(options.balancePaise, true, options.points) },
      }),
      'POST /orders': options.placeOrder ?? (() => ({ status: 201, body: { order: makeOrder() } })),
      'GET /orders/ord1': () => ({ status: 200, body: { order: makeOrder() } }),
    });
  }

  it('applies ₹1 per point and sends only the points and the total shown', async () => {
    const fetchMock = checkoutApi({ balancePaise: 10000, points: 25, maxPoints: 25 });
    renderRoute('/checkout');
    const points = await screen.findByLabelText('Points to use');
    await userEvent.type(points, '20');

    expect(screen.getByText('Loyalty points (20 points)')).toBeInTheDocument();
    expect(screen.getByText('−₹20')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pay from wallet · ₹20' }));

    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(String(init!.body))).toEqual({
      paymentMethod: 'WALLET',
      expectedTotalPaise: 2000,
      pointsToRedeem: 20,
    });
  });

  it('caps redemption at the server’s limit for this order', async () => {
    checkoutApi({ balancePaise: 10000, points: 100, maxPoints: 39 });
    renderRoute('/checkout');
    expect(
      await screen.findByText(/You can use up to 39 points on this order/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Points to use'), '40');
    expect(screen.getByText('You can use at most 39 points on this order.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay from wallet/ })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Use 39 points' }));
    expect(screen.getByRole('button', { name: 'Pay from wallet · ₹1' })).toBeEnabled();
  });

  it('lets points make the wallet enough for an order it couldn’t otherwise cover', async () => {
    checkoutApi({ balancePaise: 3000, points: 25, maxPoints: 25 });
    renderRoute('/checkout');
    expect(await screen.findByRole('radio', { name: /Orbiz wallet/ })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Points to use'), '10');
    expect(screen.getByRole('radio', { name: /Orbiz wallet/ })).toBeEnabled();
  });

  it('explains when points can’t be used on this order, and hides the section with no points', async () => {
    checkoutApi({ balancePaise: 10000, points: 5, maxPoints: 0 });
    const { unmount } = renderRoute('/checkout');
    expect(await screen.findByText(/can’t be used on this order/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Points to use')).toBeNull();
    unmount();

    checkoutApi({ balancePaise: 10000, points: 0, maxPoints: 0 });
    renderRoute('/checkout');
    await screen.findByRole('button', { name: /Pay from wallet/ });
    expect(screen.queryByRole('region', { name: 'Use loyalty points' })).toBeNull();
  });

  it('reports a refused redemption and resets the points field', async () => {
    checkoutApi({
      balancePaise: 10000,
      points: 25,
      maxPoints: 25,
      placeOrder: () => ({
        status: 409,
        body: {
          error: {
            code: 'INSUFFICIENT_POINTS',
            message: 'You don’t have that many loyalty points.',
          },
        },
      }),
    });
    renderRoute('/checkout');
    await userEvent.type(await screen.findByLabelText('Points to use'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Pay from wallet · ₹20' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You don’t have that many loyalty points.',
    );
    expect(screen.getByLabelText('Points to use')).toHaveValue('');
  });
});

describe('orders show the points discount', () => {
  it('lists subtotal, discount and total paid, and promises points back on cancel', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /orders/ord1': () => ({
        status: 200,
        body: {
          order: makeOrder({
            subtotalPaise: 4000,
            pointsRedeemed: 15,
            pointsDiscountPaise: 1500,
            totalPaise: 2500,
          }),
        },
      }),
    });
    renderRoute('/orders/ord1');
    expect(await screen.findByText('Loyalty points (15 points)')).toBeInTheDocument();
    expect(screen.getByText('−₹15')).toBeInTheDocument();
    expect(screen.getByText('Total paid')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Cancel order/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'The 15 points used will be returned too.',
    );
  });
});
