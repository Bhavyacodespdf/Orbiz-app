import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase, prisma } from '../../tests/db.js';
import { buildTestApp, devLogin } from '../../tests/helpers.js';

beforeEach(resetDatabase);

async function signedIn() {
  const agent = request.agent(buildTestApp());
  await devLogin(agent, 'student@example.com', 'Asha');
  return agent;
}

const patch = (agent: ReturnType<typeof request.agent>, body: unknown) =>
  agent
    .patch('/api/v1/me/profile')
    .set('X-Requested-With', 'CampusCart')
    .send(body as object);

describe('/api/v1/me/profile', () => {
  it('requires sign-in', async () => {
    await request(buildTestApp()).get('/api/v1/me/profile').expect(401);
  });

  it('returns the signed-in user', async () => {
    const res = await (await signedIn()).get('/api/v1/me/profile').expect(200);
    expect(res.body.user).toMatchObject({ email: 'student@example.com', displayName: 'Asha' });
  });

  it('updates the display name and phone, and clears the phone with an empty string', async () => {
    const agent = await signedIn();
    const res = await patch(agent, { displayName: '  Asha K ', phone: '+91 98765 43210' }).expect(
      200,
    );
    expect(res.body.user).toMatchObject({ displayName: 'Asha K', phone: '+91 98765 43210' });

    const cleared = await patch(agent, { phone: '' }).expect(200);
    expect(cleared.body.user.phone).toBeNull();
    expect((await prisma.user.findFirstOrThrow()).phone).toBeNull();
  });

  it('rejects attempts to change email, roles or status', async () => {
    const agent = await signedIn();
    for (const body of [{ email: 'x@y.com' }, { roles: ['ADMIN'] }, { status: 'ACTIVE' }]) {
      const res = await patch(agent, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const user = await prisma.user.findFirstOrThrow({ include: { roles: true } });
    expect(user.email).toBe('student@example.com');
    expect(user.roles.map((r) => r.role)).toEqual(['STUDENT']);
  });

  it('validates the name and phone number', async () => {
    const agent = await signedIn();
    await patch(agent, { displayName: '   ' }).expect(400);
    await patch(agent, { phone: 'call me maybe' }).expect(400);
  });
});
