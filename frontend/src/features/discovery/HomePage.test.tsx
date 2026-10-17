import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { mockApi, signedOut } from '@/test/api';
import { makeOutlet } from '@/test/outlets';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<HomePage />', () => {
  it('lists outlets from the API with status and sample labels', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets': () => ({
        status: 200,
        body: {
          outlets: [
            makeOutlet({ isSample: true }),
            makeOutlet({
              id: 'o2',
              slug: 'juice',
              name: 'Juice Junction',
              status: 'CLOSED',
              acceptingOrders: false,
            }),
          ],
        },
      }),
    });
    renderRoute('/');
    const list = await screen.findByRole('list', { name: 'Outlets' });
    const cards = within(list).getAllByRole('link');
    expect(cards[0]).toHaveAttribute('href', '/outlets/night-owl-cafe');
    expect(cards[0]).toHaveTextContent('Sample data');
    expect(cards[0]).toHaveTextContent('Open');
    expect(cards[1]).toHaveTextContent('Closed');
    expect(cards[1]).not.toHaveTextContent('Sample data');
  });

  it('sends the search to the server (debounced) and offers to clear an empty result', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
    });
    const { router } = renderRoute('/');
    await screen.findByText('No outlets yet');

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search outlets and dishes' }),
      'dosa',
    );
    expect(await screen.findByText('Nothing matches “dosa”')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toContain('/api/v1/outlets?q=dosa');
    expect(urls.some((u) => u.includes('q=d&') || u.endsWith('q=d'))).toBe(false); // debounced
    expect(router.state.location.search).toBe('?q=dosa');

    await userEvent.click(screen.getByRole('button', { name: 'Show all outlets' }));
    expect(await screen.findByText('No outlets yet')).toBeInTheDocument();
  });

  it('shows an honest empty state on an empty database', async () => {
    mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
    });
    renderRoute('/');
    expect(await screen.findByText('No outlets yet')).toBeInTheDocument();
  });

  it('shows an error with retry when outlets fail to load', async () => {
    let fail = true;
    mockApi({
      'GET /auth/me': signedOut,
      'GET /outlets': () =>
        fail
          ? {
              status: 500,
              body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
            }
          : { status: 200, body: { outlets: [makeOutlet()] } },
    });
    renderRoute('/');
    expect(await screen.findByText('Couldn’t load outlets')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Night Owl Café')).toBeInTheDocument();
  });
});
