import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import express from 'express';
import request from 'supertest';
import { redactOptions } from './logger.js';

describe('request logging', () => {
  it('redacts cookies, authorization, idempotency keys and set-cookie headers', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = express();
    app.use(pinoHttp({ logger: pino({ redact: redactOptions }, sink) }));
    app.get('/x', (_req, res) => {
      res.cookie('cc_session', 'super-secret-session-token');
      res.json({ ok: true });
    });

    await request(app)
      .get('/x')
      .set('Cookie', 'cc_session=super-secret-session-token')
      .set('Authorization', 'Bearer abc.def.ghi')
      .set('Idempotency-Key', 'cc-secret-key-123')
      .expect(200);

    const log = lines.join('\n');
    expect(log).not.toContain('super-secret-session-token');
    expect(log).not.toContain('abc.def.ghi');
    expect(log).not.toContain('cc-secret-key-123');
    expect(log).toContain('[redacted]');
  });
});
