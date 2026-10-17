import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs, signedOut } from '@/test/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

const student = makeUser();
const noOutlets = () => ({ status: 200, body: { outlets: [] } });

describe('student shell', () => {
  it('lets signed-out visitors browse the home page and offers sign-in', async () => {
    mockApi({ 'GET /auth/me': signedOut, 'GET /outlets': noOutlets });
    renderRoute('/');
    expect(await screen.findByRole('heading', { name: /Hungry\?/ })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2F',
    );
  });

  it('shows the signed-in user and main navigation', async () => {
    mockApi({ 'GET /auth/me': signedInAs(student), 'GET /outlets': noOutlets });
    renderRoute('/');
    expect(await screen.findByRole('link', { name: /Your profile:\s*Asha/ })).toBeInTheDocument();
    const navs = screen.getAllByRole('navigation', { name: 'Main' });
    expect(navs).toHaveLength(2); // desktop top bar + mobile bottom bar
    expect(within(navs[1]!).getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    for (const label of ['Outlets', 'Orders', 'Wallet']) {
      expect(within(navs[0]!).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('navigation', { name: 'Workspaces' })).not.toBeInTheDocument();
  });

  it('marks the current section as active and navigates between sections', async () => {
    mockApi({ 'GET /auth/me': signedInAs(student), 'GET /outlets': noOutlets });
    renderRoute('/');
    const [topNav] = await screen.findAllByRole('navigation', { name: 'Main' });
    await userEvent.click(within(topNav!).getByRole('link', { name: 'Wallet' }));
    expect(await screen.findByRole('heading', { name: 'Wallet', level: 1 })).toBeInTheDocument();
    expect(within(topNav!).getByRole('link', { name: 'Wallet' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('shows staff workspace links only to staff', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER', 'POS'] })),
      'GET /outlets': noOutlets,
    });
    renderRoute('/');
    const workspaces = await screen.findByRole('navigation', { name: 'Workspaces' });
    expect(within(workspaces).getByRole('link', { name: 'Kitchen' })).toHaveAttribute(
      'href',
      '/manage',
    );
    expect(within(workspaces).getByRole('link', { name: 'POS' })).toHaveAttribute('href', '/pos');
    expect(within(workspaces).queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('labels developer-login sessions', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ signInMethod: 'DEV' })),
      'GET /outlets': noOutlets,
    });
    renderRoute('/');
    expect(
      await screen.findByText(/Developer account — signed in without Google/),
    ).toBeInTheDocument();
  });
});

describe('protected routes', () => {
  it.each(['/wallet', '/orders', '/cart', '/profile'])(
    'sends signed-out visitors from %s to the login page and remembers where they were going',
    async (path) => {
      mockApi({
        'GET /auth/me': signedOut,
        'GET /auth/providers': () => ({ status: 200, body: { google: true, devLogin: false } }),
      });
      const { router } = renderRoute(path);
      expect(await screen.findByRole('heading', { name: 'Sign in to order' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/login');
      expect(router.state.location.search).toBe(`?returnTo=${encodeURIComponent(path)}`);
    },
  );

  it('shows an error with retry (not a login redirect) when the session check fails', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': () => ({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
      }),
    });
    renderRoute('/wallet');
    // Server errors are retried once (after ~1s) before the error is shown.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'Something went wrong',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/manage', ['STUDENT'], false],
    ['/manage', ['STUDENT', 'POS'], false],
    ['/manage', ['STUDENT', 'MANAGER'], true],
    ['/pos', ['STUDENT', 'MANAGER'], false],
    ['/pos', ['STUDENT', 'POS'], true],
    ['/admin', ['STUDENT', 'MANAGER', 'POS'], false],
    ['/admin', ['STUDENT', 'ADMIN'], true],
  ] as const)('%s with roles %j → allowed: %s', async (path, roles, allowed) => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: [...roles] })),
      'GET /staff/outlets': () => ({ status: 200, body: { outlets: [] } }),
      'GET /admin/users': () => ({ status: 200, body: { users: [], nextCursor: null } }),
    });
    renderRoute(path);
    if (allowed) {
      expect(
        await screen.findByText(/You’re not assigned to an outlet yet|No users yet/),
      ).toBeInTheDocument();
      expect(screen.queryByText('You don’t have access to this page')).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText('You don’t have access to this page')).toBeInTheDocument();
    }
  });
});

describe('staff and admin shells', () => {
  it('renders the manager order board with every status column', async () => {
    mockApi({
      'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER'] })),
      'GET /staff/outlets': () => ({
        status: 200,
        body: {
          outlets: [
            {
              outlet: {
                id: 'o1',
                slug: 'n',
                name: 'Night Owl Café',
                description: '',
                location: '',
                imageUrl: null,
                status: 'OPEN',
                acceptingOrders: true,
                isSample: false,
              },
              roles: ['MANAGER'],
            },
          ],
        },
      }),
      'GET /staff/outlets/o1/orders': () => ({ status: 200, body: { orders: [] } }),
    });
    renderRoute('/manage');
    expect(await screen.findByRole('heading', { name: 'Order board' })).toBeInTheDocument();
    for (const column of ['New', 'Accepted', 'Preparing', 'Ready for pickup']) {
      expect(await screen.findByRole('region', { name: column })).toHaveTextContent('No orders');
    }
    expect(screen.getByText('Live updates off')).toBeInTheDocument();
  });

  it('renders the admin console with the signed-in user and sign-out', async () => {
    mockApi({ 'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'ADMIN'] })) });
    renderRoute('/admin/audit');
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin navigation' });
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Sidebar (desktop) and compact top bar (phones/tablets) each offer sign-out.
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(2);
  });
});

describe('fallbacks', () => {
  it('renders the not-found page for unknown paths', async () => {
    mockApi({});
    renderRoute('/no-such-page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
