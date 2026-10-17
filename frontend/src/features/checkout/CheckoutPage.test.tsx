import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeCart, makeOrder, makeWallet } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(
  balancePaise: number,
  placeOrder: (init: RequestInit) => { status: number; body?: unknown },
) {
  return mockApi({
    'GET /auth/me': signedInAs(makeUser()),
    'GET /cart': () => ({ status: 200, body: { cart: makeCart() } }),
    'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(balancePaise) } }),
    'POST /orders': placeOrder,
    'GET /orders/ord1': () => ({ status: 200, body: { order: makeOrder() } }),
  });
}

describe('<CheckoutPage />', () => {
  it('pays from the wallet with an idempotency key and the total the student saw', async () => {
    const fetchMock = setup(10000, () => ({ status: 201, body: { order: makeOrder() } }));
    const { router } = renderRoute('/checkout');
    await userEvent.click(await screen.findByRole('button', { name: 'Pay from wallet · ₹40' }));

    expect(await screen.findByText('N-007')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/orders/ord1');
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(String(init!.body))).toEqual({
      paymentMethod: 'WALLET',
      expectedTotalPaise: 4000,
      pointsToRedeem: 0,
    });
    expect(new Headers(init!.headers).get('Idempotency-Key')).toMatch(/^cc-/);
  });

  it('disables the wallet when the balance is too low and offers a top-up for the shortfall', async () => {
    setup(1500, () => ({ status: 500 }));
    renderRoute('/checkout');
    expect(await screen.findByRole('radio', { name: /CampusCart wallet/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Pay at the counter/ })).toBeChecked();
    expect(screen.getByText(/You need/)).toHaveTextContent('₹25');
    // The shortfall is ₹25, but the smallest recharge is ₹99.
    expect(screen.getByRole('link', { name: 'Add ₹99 to wallet' })).toHaveAttribute(
      'href',
      '/wallet?amount=99&returnTo=%2Fcheckout',
    );
  });

  it('reuses the same idempotency key when the student retries after a network failure', async () => {
    let attempts = 0;
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart() } }),
      'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(0) } }),
      'POST /orders': () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new TypeError('Failed to fetch'));
        return {
          status: 201,
          body: {
            order: makeOrder({ paymentMethod: 'COUNTER', paymentStatus: 'PENDING_COUNTER' }),
          },
        };
      },
      'GET /orders/ord1': () => ({ status: 200, body: { order: makeOrder() } }),
    });
    renderRoute('/checkout');
    const button = await screen.findByRole('button', { name: 'Place order · ₹40' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach CampusCart');
    await userEvent.click(screen.getByRole('button', { name: 'Place order · ₹40' }));
    await screen.findByText('N-007');

    const keys = fetchMock.mock.calls
      .filter(([, i]) => i?.method === 'POST')
      .map(([, i]) => new Headers(i!.headers).get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('explains a price change instead of silently charging a different amount', async () => {
    setup(10000, () => ({
      status: 409,
      body: { error: { code: 'PRICE_CHANGED', message: 'x', details: { totalPaise: 5000 } } },
    }));
    renderRoute('/checkout');
    await userEvent.click(await screen.findByRole('button', { name: 'Pay from wallet · ₹40' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the new total is ₹50');
  });

  it('tells the student the outlet is full, keeps the cart, and pauses placing until room opens', async () => {
    const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const fetchMock = setup(10000, () => ({
      status: 429,
      body: {
        error: {
          code: 'ORDER_CAPACITY_FULL',
          message:
            'This outlet has reached its order capacity and is temporarily not accepting new orders. Please try again shortly.',
          details: { retryAt, retryAfterSeconds: 3600 },
        },
      },
    }));
    const { router } = renderRoute('/checkout');
    const pay = await screen.findByRole('button', { name: 'Pay from wallet · ₹40' });
    await userEvent.click(pay);
    expect(await screen.findByText(/reached its order capacity/)).toHaveTextContent(
      /You can try again from/,
    );
    // Still on checkout with the cart's items; no second submission is possible yet.
    expect(router.state.location.pathname).toBe('/checkout');
    expect(screen.getByText(/Masala chai/)).toBeInTheDocument();
    expect(pay).toBeDisabled();
    await userEvent.click(pay);
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
  });
});
