import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs, signedOut } from '@/test/api';
import { makeMenuItem, makeOutlet } from '@/test/outlets';
import { emptyCart, makeCart } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

const categories = [{ id: 'c1', name: 'Hot drinks', sortOrder: 0 }];
const menu =
  (
    items = [makeMenuItem(), makeMenuItem({ id: 'i9', name: 'Sandwich', isAvailable: false })],
    outlet = makeOutlet(),
  ) =>
  () => ({ status: 200, body: { outlet, categories, items } });

describe('adding to cart from the menu', () => {
  it('sends signed-out visitors to sign in first', async () => {
    mockApi({ 'GET /auth/me': signedOut, 'GET /outlets/night-owl-cafe/menu': menu() });
    const { router } = renderRoute('/outlets/night-owl-cafe');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Masala chai to cart' }));
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?returnTo=%2Foutlets%2Fnight-owl-cafe');
  });

  it('offers no Add button for sold-out items or when the outlet is closed', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart: emptyCart() } }),
      'GET /outlets/night-owl-cafe/menu': menu(),
    });
    renderRoute('/outlets/night-owl-cafe');
    await screen.findByRole('button', { name: 'Add Masala chai to cart' });
    expect(screen.queryByRole('button', { name: 'Add Sandwich to cart' })).not.toBeInTheDocument();
  });

  it('adds through the API and then shows the server quantity and cart bar', async () => {
    let cart = emptyCart();
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({ status: 200, body: { cart } }),
      'GET /outlets/night-owl-cafe/menu': menu(),
      'POST /cart/items': () => {
        cart = makeCart({
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
        return { status: 200, body: { cart } };
      },
    });
    renderRoute('/outlets/night-owl-cafe');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Masala chai to cart' }));

    const stepper = await screen.findByRole('group', { name: 'Quantity of Masala chai' });
    expect(within(stepper).getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /1 item · ₹20/ })).toHaveAttribute('href', '/cart');
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ menuItemId: 'i1', replaceCart: false });
  });

  it('asks before replacing a cart from another outlet, and only replaces on confirmation', async () => {
    const bodies: unknown[] = [];
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /cart': () => ({
        status: 200,
        body: {
          cart: makeCart({
            outlet: {
              id: 'o2',
              slug: 'tandoor',
              name: 'Tandoor Corner',
              status: 'OPEN',
              acceptingOrders: true,
            },
          }),
        },
      }),
      'GET /outlets/night-owl-cafe/menu': menu(),
      'POST /cart/items': (init) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        return body.replaceCart
          ? { status: 200, body: { cart: makeCart() } }
          : {
              status: 409,
              body: {
                error: {
                  code: 'CART_OUTLET_CONFLICT',
                  message: 'conflict',
                  details: {
                    currentOutlet: { name: 'Tandoor Corner' },
                    newOutlet: { name: 'Night Owl Café' },
                  },
                },
              },
            };
      },
    });
    renderRoute('/outlets/night-owl-cafe');
    await userEvent.click(await screen.findByRole('button', { name: 'Add Masala chai to cart' }));

    const dialog = await screen.findByRole('dialog', { name: 'Start a new cart?' });
    expect(dialog).toHaveTextContent('Tandoor Corner');
    expect(within(dialog).getByRole('button', { name: 'Keep my cart' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start new cart' }));

    expect(bodies).toEqual([
      { menuItemId: 'i1', replaceCart: false },
      { menuItemId: 'i1', replaceCart: true },
    ]);
  });
});
