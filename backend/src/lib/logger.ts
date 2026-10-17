import { pino } from 'pino';
import { env } from '../config/env.js';

/** Never let credentials, session tokens or idempotency keys reach the logs. */
export const redactOptions = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.headers["idempotency-key"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.token',
    '*.secret',
  ],
  censor: '[redacted]',
};

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: redactOptions,
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});
