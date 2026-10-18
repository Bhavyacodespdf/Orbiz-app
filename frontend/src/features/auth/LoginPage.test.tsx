import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '@/test/render';
import { makeUser, mockApi, signedOut } from '@/test/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

const providers = (google: boolean, devLogin: boolean) => () => ({
  status: 200,
  body: { google, devLogin },
});

describe('<LoginPage />', () => {
  it('links to the real Google flow, carrying the return path', async () => {
    mockApi({ 'GET /auth/me': signedOut, 'GET /auth/providers': providers(true, false) });
    renderRoute('/login?returnTo=%2Fwallet');
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/v1/auth/google?returnTo=%2Fwallet',
    );
    expect(screen.queryByText(/Developer login/)).not.toBeInTheDocument();
  });

  it('says plainly when Google is not configured', async () => {
    mockApi({ 'GET /auth/me': signedOut, 'GET /auth/providers': providers(false, false) });
    renderRoute('/login');
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    expect(screen.getByText(/isn’t configured on this server/)).toBeInTheDocument();
  });

  it('ignores unsafe return paths', async () => {
    mockApi({ 'GET /auth/me': signedOut, 'GET /auth/providers': providers(true, false) });
    renderRoute('/login?returnTo=%2F%2Fevil.example');
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/v1/auth/google?returnTo=%2F',
    );
  });

  it.each([
    ['EMAIL_CONFLICT', /already uses this email address/],
    ['OAUTH_STATE_INVALID', /expired or was already used/],
    ['GOOGLE_CANCELLED', /Sign-in was cancelled/],
    ['SOMETHING_NEW', /Sign-in failed/],
  ])('explains the %s error', async (code, message) => {
    mockApi({ 'GET /auth/me': signedOut, 'GET /auth/providers': providers(true, false) });
    renderRoute(`/login?error=${code}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('redirects away when already signed in', async () => {
    mockApi({
      'GET /auth/me': () => ({ status: 200, body: { user: makeUser() } }),
      'GET /auth/providers': providers(true, false),
    });
    const { router } = renderRoute('/login?returnTo=%2Forders');
    await screen.findByRole('heading', { name: 'Orders', level: 1 });
    expect(router.state.location.pathname).toBe('/orders');
  });

  describe('developer login', () => {
    it('validates the email before sending anything', async () => {
      const fetchMock = mockApi({
        'GET /auth/me': signedOut,
        'GET /auth/providers': providers(false, true),
      });
      renderRoute('/login');
      await userEvent.type(await screen.findByLabelText('Email'), 'nope');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in as developer' }));
      expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('signs in and continues to the requested page', async () => {
      const devUser = makeUser({ email: 'dev@example.com', signInMethod: 'DEV' });
      const fetchMock = mockApi({
        'GET /auth/me': signedOut,
        'GET /auth/providers': providers(false, true),
        'POST /auth/dev-login': () => ({ status: 200, body: { user: devUser } }),
      });
      const { router } = renderRoute('/login?returnTo=%2Fwallet');
      await userEvent.type(await screen.findByLabelText('Email'), 'dev@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in as developer' }));

      expect(await screen.findByRole('heading', { name: 'Wallet', level: 1 })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/wallet');
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
      expect(JSON.parse(String(post[1]!.body))).toEqual({ email: 'dev@example.com' });
      expect(new Headers(post[1]!.headers).get('X-Requested-With')).toBe('CampusCart');
    });

    it('shows the server error when sign-in is refused', async () => {
      mockApi({
        'GET /auth/me': signedOut,
        'GET /auth/providers': providers(false, true),
        'POST /auth/dev-login': () => ({
          status: 409,
          body: {
            error: {
              code: 'EMAIL_CONFLICT',
              message: 'Another Orbiz account already uses this email address.',
            },
          },
        }),
      });
      renderRoute('/login');
      await userEvent.type(await screen.findByLabelText('Email'), 'taken@example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in as developer' }));
      expect(await screen.findByText(/already uses this email address/)).toBeInTheDocument();
    });
  });
});
