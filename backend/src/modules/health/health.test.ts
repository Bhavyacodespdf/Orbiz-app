import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma, type Database } from '../../lib/prisma.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/health', () => {
  it('reports the real test database as up', async () => {
    const res = await request(createApp({ db: prisma })).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: { status: 'up' } });
  });

  it('returns 503 when the database cannot be reached', async () => {
    const unreachable = {
      $queryRaw: () => Promise.reject(new Error('connection refused')),
    } as unknown as Database;
    const res = await request(createApp({ db: unreachable })).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: { status: 'down' } });
  });
});

describe('API error handling', () => {
  const app = createApp({ db: prisma });

  it('returns a consistent 404 shape for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects request bodies over the size limit', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
