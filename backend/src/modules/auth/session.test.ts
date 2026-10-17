import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { resetDatabase, prisma } from '../../tests/db.js';
import { buildTestApp, devLogin, FRONTEND, testConfig } from '../../tests/helpers.js';
import { sha256 } from '../../lib/crypto.js';
import { loadSession, requireRole } from '../../middleware/auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { grantRole, revokeRole } from '../users/roles.service.js';

beforeEach(resetDatabase);

function sessionCookieFrom(res: request.Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((c) => c.startsWith('cc_session='))!;
  return cookie.split(';')[0]!.split('=')[1]!;
}

describe('sessions', () => {
  it('returns 401 from /auth/me without a session', async () => {
    const res = await request(buildTestApp()).get('/api/v1/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('ignores garbage session cookies', async () => {
    await request(buildTestApp())
      .get('/api/v1/auth/me')
      .set('Cookie', 'cc_session=not-a-real-token')
      .expect(401);
  });

  it('sets an http-only, SameSite=Lax cookie and stores only a hash of the token', async () => {
    const res = await devLogin(request.agent(buildTestApp()), 'student@example.com');
    const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);

    const token = sessionCookieFrom(res);
    const session = await prisma.session.findFirstOrThrow();
    expect(session.tokenHash).toBe(sha256(token));
    expect(session.tokenHash).not.toContain(token);
  });

  it('rejects and deletes an idle-expired session', async () => {
    const agent = request.agent(buildTestApp());
    await devLogin(agent, 'student@example.com');
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await agent.get('/api/v1/auth/me').expect(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('enforces the absolute session lifetime even for active sessions', async () => {
    const agent = request.agent(buildTestApp());
    await devLogin(agent, 'student@example.com');
    await prisma.session.updateMany({ data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('logs out: deletes the session, clears the cookie, and the old token stops working', async () => {
    const app = buildTestApp();
    const login = await devLogin(request.agent(app), 'student@example.com');
    const token = sessionCookieFrom(login);

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `cc_session=${token}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/cc_session=;/);
    expect(await prisma.session.count()).toBe(0);

    await request(app).get('/api/v1/auth/me').set('Cookie', `cc_session=${token}`).expect(401);
  });

  it('stops honouring sessions of a suspended account', async () => {
    const agent = request.agent(buildTestApp());
    await devLogin(agent, 'student@example.com');
    await prisma.user.updateMany({ data: { status: 'SUSPENDED' } });
    await agent.get('/api/v1/auth/me').expect(401);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the verification header', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/auth/dev-login')
      .send({ email: 'a@example.com' })
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects requests from a foreign origin even with the header', async () => {
    const res = await request(buildTestApp())
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://evil.example')
      .set('X-Requested-With', 'CampusCart')
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('accepts requests from our own frontend', async () => {
    await request(buildTestApp())
      .post('/api/v1/auth/logout')
      .set('Origin', FRONTEND)
      .set('X-Requested-With', 'CampusCart')
      .expect(204);
  });
});

describe('developer login', () => {
  it('does not exist when DEV_LOGIN_ENABLED is false', async () => {
    const app = buildTestApp({ config: testConfig({ DEV_LOGIN_ENABLED: 'false' }) });
    await request(app)
      .post('/api/v1/auth/dev-login')
      .set('X-Requested-With', 'CampusCart')
      .send({ email: 'a@example.com' })
      .expect(404);
    const providers = await request(app).get('/api/v1/auth/providers').expect(200);
    expect(providers.body.devLogin).toBe(false);
  });

  it('creates a clearly marked developer account and applies the allowlists', async () => {
    const res = await devLogin(request.agent(buildTestApp()), 'Singlahimanshi2@gmail.com', 'Dev');
    expect(res.body.user).toMatchObject({
      email: 'singlahimanshi2@gmail.com',
      signInMethod: 'DEV',
      roles: ['STUDENT', 'MANAGER', 'POS'],
    });
  });

  it('validates input', async () => {
    await request(buildTestApp())
      .post('/api/v1/auth/dev-login')
      .set('X-Requested-With', 'CampusCart')
      .send({ email: 'not-an-email' })
      .expect(400);
  });

  it('rate-limits repeated sign-in attempts', async () => {
    const app = buildTestApp({ config: testConfig({ AUTH_RATE_LIMIT_MAX: '2' }) });
    const attempt = () =>
      request(app)
        .post('/api/v1/auth/dev-login')
        .set('X-Requested-With', 'CampusCart')
        .send({ email: 'a@example.com' });
    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(200);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('role enforcement', () => {
  const config = testConfig();

  // A tiny app with one Manager-only route, wired with the real middleware.
  function protectedApp() {
    const app = express();
    app.use(cookieParser());
    app.use(loadSession(prisma, config));
    app.get('/manager-only', requireRole('MANAGER'), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  }

  async function tokenFor(email: string) {
    return sessionCookieFrom(await devLogin(request.agent(buildTestApp()), email));
  }

  it('returns 401 when signed out and 403 for a Student', async () => {
    const app = protectedApp();
    await request(app).get('/manager-only').expect(401);
    const token = await tokenFor('student@example.com');
    const res = await request(app).get('/manager-only').set('Cookie', `cc_session=${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows a Manager, and a revoked role stops working on the very next request', async () => {
    const app = protectedApp();
    const token = await tokenFor('singlahimanshi2@gmail.com');
    await request(app).get('/manager-only').set('Cookie', `cc_session=${token}`).expect(200);

    await revokeRole(prisma, {
      email: 'singlahimanshi2@gmail.com',
      role: 'MANAGER',
      reason: 'Test revocation',
      actor: { type: 'CLI' },
    });
    // Revocation also ends sessions, so the old cookie is now simply signed out.
    await request(app).get('/manager-only').set('Cookie', `cc_session=${token}`).expect(401);

    const fresh = await tokenFor('singlahimanshi2@gmail.com');
    await request(app).get('/manager-only').set('Cookie', `cc_session=${fresh}`).expect(403);
  });

  it('reads roles from the database, not from anything the client sends', async () => {
    const app = protectedApp();
    const token = await tokenFor('student@example.com');
    await request(app)
      .get('/manager-only')
      .set('Cookie', `cc_session=${token}; role=MANAGER`)
      .set('X-Role', 'MANAGER')
      .expect(403);

    // Even a direct DB grant (as the CLI would do) takes effect without re-login.
    await prisma.user.updateMany({ data: { emailVerified: true } });
    await expect(
      grantRole(prisma, {
        email: 'student@example.com',
        role: 'MANAGER',
        actor: { type: 'CLI' },
        lists: { ...config, MANAGER_ALLOWED_EMAILS: ['student@example.com'] },
      }),
    ).resolves.toMatchObject({ changed: true });
    await request(app).get('/manager-only').set('Cookie', `cc_session=${token}`).expect(200);
  });
});
