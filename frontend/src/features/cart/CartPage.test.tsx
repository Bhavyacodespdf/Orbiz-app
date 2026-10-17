import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { emptyCart, makeCart } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<CartPage />', () => {
  it('shows server-calculated line totals and total, and links to checkout', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: makeCart() } }),
    });
    renderRoute('/cart');
    expect(await screen.findByText('Masala chai')).toBeInTheDocument();
    expect(screen.getAllByText('₹40').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Continue to checkout' })).toHaveAttribute(
      'href',
      '/checkout',
    );
  });

  it('blocks checkout and names items that became unavailable', async () => {
    const cart = makeCart({
      issues: [{ menuItemId: 'i1', name: 'Masala chai', reason: 'SOLD_OUT' }],
      canCheckout: false,
      canSchedule: false,
    });
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart } }),
    });
    renderRoute('/cart');
    expect(await screen.findByRole('alert')).toHaveTextContent('Masala chai');
    expect(screen.getByRole('button', { name: 'Continue to checkout' })).toBeDisabled();
  });

  it('explains when fewer are left than the cart wants', async () => {
    const cart = makeCart({
      issues: [{ menuItemId: 'i1', name: 'Masala chai', reason: 'NOT_ENOUGH_STOCK', available: 1 }],
      canCheckout: false,
      canSchedule: false,
    });
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart } }),
    });
    renderRoute('/cart');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Masala chai: only 1 left — lower the quantity to continue.',
    );
    expect(screen.getByRole('button', { name: 'Continue to checkout' })).toBeDisabled();
  });

  it('removes an item through the API', async () => {
    let cart = makeCart({
      items: [
        {
          menuItemId: 'i1',
          name: 'Masala chai',
          dietary: 'VEG',
          unitPricePaise: 2000,
          quantity: 1,
          lineTotalPaise: 2000,
          isOrderable: true,
          stockStatus: 'AVAILABLE' as const,
        },
      ],
    });
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart } }),
      'DELETE /cart/items/i1': () => {
        cart = emptyCart();
        return { status: 200, body: { cart } };
      },
    });
    renderRoute('/cart');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Masala chai' }));
    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
  });
});
