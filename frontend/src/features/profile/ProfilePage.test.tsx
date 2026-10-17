import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedInAs } from '@/test/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<ProfilePage />', () => {
  it('shows the account, its roles and links to staff workspaces', async () => {
    mockApi({ 'GET /auth/me': signedInAs(makeUser({ roles: ['STUDENT', 'MANAGER', 'POS'] })) });
    renderRoute('/profile');
    expect(await screen.findByText('asha@example.com')).toBeInTheDocument();
    expect(screen.getByText('Manager')).toBeInTheDocument();
    expect(screen.getByText('POS / Cashier')).toBeInTheDocument();
    const workspaces = screen.getByRole('region', { name: 'Your workspaces' });
    expect(within(workspaces).getByRole('link', { name: /Kitchen/ })).toHaveAttribute(
      'href',
      '/manage',
    );
  });

  it('saves only the editable fields and confirms', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': signedInAs(makeUser()),
      'PATCH /me/profile': (init) => ({
        status: 200,
        body: { user: makeUser({ ...JSON.parse(String(init.body)) }) },
      }),
    });
    renderRoute('/profile');
    const save = await screen.findByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled(); // nothing changed yet

    await userEvent.type(screen.getByLabelText('Phone (optional)'), '+91 98765 43210');
    await userEvent.click(save);

    expect(await screen.findByText('Profile saved')).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({
      displayName: 'Asha',
      phone: '+91 98765 43210',
    });
  });

  it('validates the phone number on the client too', async () => {
    const fetchMock = mockApi({ 'GET /auth/me': signedInAs(makeUser()) });
    renderRoute('/profile');
    await userEvent.type(await screen.findByLabelText('Phone (optional)'), 'call me');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a valid phone number')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('signs out, forgets the user and returns home', async () => {
    let signedIn = true;
    const fetchMock = mockApi({
      'GET /auth/me': () =>
        signedIn
          ? { status: 200, body: { user: makeUser() } }
          : { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } },
      'POST /auth/logout': () => {
        signedIn = false;
        return { status: 204 };
      },
      'GET /outlets': () => ({ status: 200, body: { outlets: [] } }),
    });
    const { router } = renderRoute('/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    // Wait for the settled end state: home page, signed out (not redirected to the login page).
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
      expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    });
    expect(router.state.location.search).toBe('');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/logout'))).toBe(true);
  });
});
