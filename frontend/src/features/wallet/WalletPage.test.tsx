import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';
import { makeTransaction, makeWallet } from '@/test/commerce';

afterEach(() => {
  vi.unstubAllGlobals();
});

const noPoints = { pointsBalance: 0, transactions: [], nextCursor: null };

const recharge = {
  id: 'r2',
  amountPaise: 50000,
  status: 'PENDING',
  bonusPoints: 10,
  provider: 'MOCK',
  providerReference: 'mock_abc',
  isSimulated: true,
  failureReason: null,
  expiresAt: '2026-10-16T09:00:00.000Z',
  createdAt: '2026-10-16T08:45:00.000Z',
  completedAt: null,
};

describe('<WalletPage />', () => {
  it('shows the balance from the server, labelled as simulated funds', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(10000) } }),
      'GET /wallet/points': () => ({ status: 200, body: noPoints }),
      'GET /wallet/transactions': () => ({
        status: 200,
        body: { transactions: [], nextCursor: null },
      }),
    });
    renderRoute('/wallet');
    const balance = await screen.findByRole('region', { name: 'Available balance' });
    expect(balance).toHaveTextContent('₹100');
    expect(balance).toHaveTextContent('Simulated test funds');
    expect(screen.getByText(/Test mode — simulated funds/)).toBeInTheDocument();
    expect(screen.getByText('No transactions yet')).toBeInTheDocument();
  });

  it('validates the amount before calling the server', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(0) } }),
      'GET /wallet/points': () => ({ status: 200, body: noPoints }),
      'GET /wallet/transactions': () => ({
        status: 200,
        body: { transactions: [], nextCursor: null },
      }),
    });
    renderRoute('/wallet');
    await userEvent.type(await screen.findByLabelText('Amount'), '98');
    await userEvent.click(screen.getByRole('button', { name: 'Add ₹98' }));
    expect(await screen.findByText('The minimum recharge is ₹99.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('runs the simulated recharge: start → simulator → server outcome → refreshed balance', async () => {
    let balance = 10000;
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(balance) } }),
      'GET /wallet/points': () => ({ status: 200, body: noPoints }),
      'GET /wallet/transactions': () => ({
        status: 200,
        body: { transactions: [], nextCursor: null },
      }),
      'POST /wallet/recharges': () => ({
        status: 201,
        body: { recharge, nextAction: { type: 'MOCK_SIMULATOR' } },
      }),
      'POST /payments/mock/r2/outcome': () => {
        balance = 60000;
        return {
          status: 200,
          body: {
            changed: true,
            recharge: { ...recharge, status: 'SUCCEEDED' },
            wallet: { balancePaise: 60000 },
          },
        };
      },
    });
    renderRoute('/wallet');
    await userEvent.click(await screen.findByRole('button', { name: '₹500 +10 points' }));
    expect(
      screen.getByText('You’ll earn 10 points (worth ₹10) once this recharge succeeds.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add ₹500' }));

    const dialog = await screen.findByRole('dialog', { name: 'Test payment simulator' });
    expect(dialog).toHaveTextContent('No real money moves');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Simulate successful payment' }),
    );

    expect(await screen.findByText('Wallet recharged (simulated)')).toBeInTheDocument();
    expect(screen.getByText('You earned 10 points (test mode).')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Available balance' })).toHaveTextContent(
      '₹600',
    );
    const start = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/wallet/recharges'))!;
    expect(JSON.parse(String(start[1]!.body))).toEqual({ amountPaise: 50000 });
    expect(new Headers(start[1]!.headers).get('Idempotency-Key')).toMatch(/^cc-/);
  });

  it('says plainly when recharge is unavailable', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(0, false) } }),
      'GET /wallet/points': () => ({ status: 200, body: noPoints }),
      'GET /wallet/transactions': () => ({
        status: 200,
        body: { transactions: [], nextCursor: null },
      }),
    });
    renderRoute('/wallet');
    expect(await screen.findByText(/no payment provider is configured/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add ₹/ })).not.toBeInTheDocument();
  });

  it('lists history with statuses, opens details, and loads more pages', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'GET /wallet': () => ({ status: 200, body: { wallet: makeWallet(10000) } }),
      'GET /wallet/points': () => ({ status: 200, body: noPoints }),
      'GET /wallet/transactions': () => ({
        status: 200,
        body: {
          transactions: [
            makeTransaction({
              id: 't2',
              type: 'ORDER_DEBIT',
              direction: 'DEBIT',
              amountPaise: 4000,
              orderId: 'ord1',
              description: 'Order N-007 at Night Owl Café',
            }),
            makeTransaction({
              id: 't3',
              status: 'FAILED',
              balanceAfterPaise: null,
              completedAt: null,
            }),
          ],
          nextCursor: 'next',
        },
      }),
    });
    renderRoute('/wallet');
    const list = await screen.findByRole('list', { name: 'Wallet transactions' });
    expect(within(list).getByText('Failed')).toBeInTheDocument();
    expect(within(list).getByText('−₹40')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /Order payment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Order payment' });
    expect(within(dialog).getByRole('link', { name: 'View order' })).toHaveAttribute(
      'href',
      '/orders/ord1',
    );
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});
