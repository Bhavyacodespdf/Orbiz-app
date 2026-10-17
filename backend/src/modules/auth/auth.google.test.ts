import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase, prisma } from '../../tests/db.js';
import { buildTestApp, FakeGoogle, FRONTEND, signInWithFakeGoogle } from '../../tests/helpers.js';

// NOTE: these tests drive the real routes, cookies, sessions and database, but
// Google itself is replaced by FakeGoogle. They do not prove that sign-in with
// real Google credentials works — that needs a manual test (docs/google-oauth-setup.md).

let google: FakeGoogle;
let agent: ReturnType<typeof request.agent>;

beforeEach(async () => {
  await resetDatabase();
  google = new FakeGoogle();
  agent = request.agent(buildTestApp({ google }));
});

describe('GET /api/v1/auth/providers', () => {
  it('reports which sign-in methods are available', async () => {
    const withGoogle = await agent.get('/api/v1/auth/providers').expect(200);
    expect(withGoogle.body).toEqual({ google: true, devLogin: true });

    const withoutGoogle = await request(buildTestApp({ google: null }))
      .get('/api/v1/auth/providers')
      .expect(200);
    expect(withoutGoogle.body.google).toBe(false);
  });
});

describe('Google sign-in start', () => {
  it('explains when Google is not configured instead of failing silently', async () => {
    const res = await request(buildTestApp({ google: null })).get('/api/v1/auth/google');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=GOOGLE_NOT_CONFIGURED`);
  });

  it('redirects to Google with state, nonce and a PKCE challenge in a signed, http-only cookie', async () => {
    const res = await agent.get('/api/v1/auth/google?returnTo=/wallet').expect(303);
    const url = new URL(res.headers.location!);
    expect(url.searchParams.get('state')).toBe(google.lastAuthParams!.state);
    expect(url.searchParams.get('nonce')).toBe(google.lastAuthParams!.nonce);
    expect(url.searchParams.get('codeChallenge')).toBe('challenge');
    expect(google.lastAuthParams!.state).not.toBe(google.lastAuthParams!.nonce);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_oauth='),
    )!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(decodeURIComponent(cookie)).toMatch(/^cc_oauth=s:/); // signed
  });
});

describe('Google sign-in callback', () => {
  it('registers a Student from ANY email domain and starts a session', async () => {
    const res = await signInWithFakeGoogle(
      agent,
      google,
      { subject: 'g-1', email: 'Asha@Some-Other-University.ac.in', name: 'Asha' },
      '/wallet',
    );
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${FRONTEND}/wallet`);

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      email: 'asha@some-other-university.ac.in',
      displayName: 'Asha',
      roles: ['STUDENT'],
      signInMethod: 'GOOGLE',
    });

    const identity = await prisma.authIdentity.findFirstOrThrow();
    expect(identity).toMatchObject({ provider: 'GOOGLE', subject: 'g-1' });
  });

  it('does not allow open redirects through returnTo', async () => {
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const res = await signInWithFakeGoogle(
        agent,
        google,
        { subject: `g-${evil}`, email: `x${Math.random()}@example.com` },
        evil,
      );
      expect(res.headers.location).toBe(`${FRONTEND}/`);
    }
  });

  it('rejects a callback whose state does not match', async () => {
    google.willReturn('code-1', { subject: 'g-1', email: 'a@example.com' });
    await agent.get('/api/v1/auth/google').expect(303);
    const res = await agent.get('/api/v1/auth/google/callback?state=forged&code=code-1');
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=OAUTH_STATE_INVALID`);
    expect(await prisma.user.count()).toBe(0);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('rejects a callback that was not started by this browser (no state cookie)', async () => {
    google.willReturn('code-1', { subject: 'g-1', email: 'a@example.com' });
    await agent.get('/api/v1/auth/google').expect(303);
    const state = google.lastAuthParams!.state;
    const otherBrowser = request(buildTestApp({ google }));
    const res = await otherBrowser.get(`/api/v1/auth/google/callback?state=${state}&code=code-1`);
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=OAUTH_STATE_INVALID`);
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects a tampered (unsigned) state cookie', async () => {
    google.willReturn('code-1', { subject: 'g-1', email: 'a@example.com' });
    const forged = JSON.stringify({ state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/' });
    const res = await request(buildTestApp({ google }))
      .get('/api/v1/auth/google/callback?state=s&code=code-1')
      .set('Cookie', `cc_oauth=${encodeURIComponent(forged)}`);
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=OAUTH_STATE_INVALID`);
  });

  it('treats the state as single-use (a replayed callback fails)', async () => {
    google.willReturn('code-1', { subject: 'g-1', email: 'a@example.com' });
    await agent.get('/api/v1/auth/google').expect(303);
    const url = `/api/v1/auth/google/callback?state=${google.lastAuthParams!.state}&code=code-1`;
    expect((await agent.get(url)).headers.location).toBe(`${FRONTEND}/`);
    expect((await agent.get(url)).headers.location).toBe(
      `${FRONTEND}/login?error=OAUTH_STATE_INVALID`,
    );
  });

  it('rejects an ID token whose nonce does not match this sign-in', async () => {
    const res = await signInWithFakeGoogle(agent, google, {
      subject: 'g-1',
      email: 'a@example.com',
      nonce: 'replayed-token-nonce',
    });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=OAUTH_STATE_INVALID`);
    expect(await prisma.user.count()).toBe(0);
  });

  it('reports a failed code exchange / token verification', async () => {
    google.failNextExchange = true;
    const res = await signInWithFakeGoogle(agent, google, { subject: 'g-1', email: 'a@x.com' });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=GOOGLE_VERIFICATION_FAILED`);
  });

  it('handles the user cancelling on Google’s consent screen', async () => {
    await agent.get('/api/v1/auth/google').expect(303);
    const res = await agent.get(
      `/api/v1/auth/google/callback?error=access_denied&state=${google.lastAuthParams!.state}`,
    );
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=GOOGLE_CANCELLED`);
  });

  it('never links a new Google account to an existing account by email', async () => {
    await signInWithFakeGoogle(agent, google, { subject: 'g-original', email: 'same@example.com' });
    const intruder = request.agent(buildTestApp({ google }));
    const res = await signInWithFakeGoogle(intruder, google, {
      subject: 'g-different',
      email: 'same@example.com',
    });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=EMAIL_CONFLICT`);
    await intruder.get('/api/v1/auth/me').expect(401);
    expect(await prisma.authIdentity.count()).toBe(1);
  });

  it('signs a returning user in to the same account', async () => {
    await signInWithFakeGoogle(agent, google, { subject: 'g-1', email: 'a@example.com' });
    const again = request.agent(buildTestApp({ google }));
    await signInWithFakeGoogle(again, google, { subject: 'g-1', email: 'a@example.com' });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(2);
  });
});
