import { describe, expect, it } from 'vitest';
import { devLoginAllowed, googleConfig, parseEnv } from './env.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user@localhost:5432/campuscart_dev',
  FRONTEND_URL: 'http://localhost:5173',
  BACKEND_URL: 'http://localhost:4000',
  SESSION_SECRET: 'x'.repeat(32),
};

const google = {
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_CALLBACK_URL: 'https://campuscart.example/api/v1/auth/google/callback',
};

describe('environment validation', () => {
  it('accepts a minimal development configuration with defaults', () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.PAYMENT_MOCK_ENABLED).toBe(false);
    expect(env.MANAGER_ALLOWED_EMAILS).toEqual([]);
  });

  it('normalises and de-duplicates allowlisted emails', () => {
    const env = parseEnv({
      ...base,
      MANAGER_ALLOWED_EMAILS:
        ' Singlahimanshi2@Gmail.com , singlahimanshi2@gmail.com,,other@example.org ',
    });
    expect(env.MANAGER_ALLOWED_EMAILS).toEqual(['singlahimanshi2@gmail.com', 'other@example.org']);
  });

  it('rejects malformed allowlist entries', () => {
    expect(() => parseEnv({ ...base, POS_ALLOWED_EMAILS: 'not-an-email' })).toThrow(
      /POS_ALLOWED_EMAILS/,
    );
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('refuses mock payments in production', () => {
    expect(() =>
      parseEnv({ ...base, ...google, NODE_ENV: 'production', PAYMENT_MOCK_ENABLED: 'true' }),
    ).toThrow(/Mock payments cannot be enabled in production/);
  });

  it('keeps the order capacity at 10 per 3 minutes in production', () => {
    expect(parseEnv({ ...base, ...google, NODE_ENV: 'production' }).ORDER_CAPACITY_PER_WINDOW).toBe(
      10,
    );
    expect(() =>
      parseEnv({ ...base, ...google, NODE_ENV: 'production', ORDER_CAPACITY_PER_WINDOW: '50' }),
    ).toThrow(/order capacity is fixed/);
  });

  it('refuses the developer login in production', () => {
    expect(() =>
      parseEnv({ ...base, ...google, NODE_ENV: 'production', DEV_LOGIN_ENABLED: 'true' }),
    ).toThrow(/developer login cannot be enabled in production/);
  });

  it('allows mock payments outside production', () => {
    expect(parseEnv({ ...base, PAYMENT_MOCK_ENABLED: 'true' }).PAYMENT_MOCK_ENABLED).toBe(true);
  });

  it('rejects inconsistent wallet limits', () => {
    expect(() =>
      parseEnv({ ...base, WALLET_RECHARGE_MIN_PAISE: '500000', WALLET_RECHARGE_MAX_PAISE: '1000' }),
    ).toThrow(/Minimum recharge/);
  });

  it('requires a session secret of at least 32 characters', () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('requires Google credentials in production but not in development', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/GOOGLE_CLIENT_ID/);
    expect(googleConfig(parseEnv(base))).toBeNull();
    expect(googleConfig(parseEnv({ ...base, ...google }))).toEqual({
      clientId: google.GOOGLE_CLIENT_ID,
      clientSecret: google.GOOGLE_CLIENT_SECRET,
      callbackUrl: google.GOOGLE_CALLBACK_URL,
    });
  });

  it('only allows the developer login outside production', () => {
    expect(devLoginAllowed(parseEnv({ ...base, DEV_LOGIN_ENABLED: 'true' }))).toBe(true);
    expect(devLoginAllowed(parseEnv(base))).toBe(false);
  });

  it('parses TRUST_PROXY as a hop count or an Express trust-proxy string', () => {
    expect(parseEnv(base).TRUST_PROXY).toBe('loopback');
    expect(parseEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(parseEnv({ ...base, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toBe('10.0.0.0/8');
  });
});
