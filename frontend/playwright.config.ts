import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run the real backend and frontend against an ISOLATED
 * database (campuscart_e2e) on their own ports, so they never touch your
 * development data or a running dev server.
 *
 * Sign-in uses the developer login (DEV_LOGIN_ENABLED) — this does NOT test
 * real Google sign-in, which needs a manual test (docs/google-oauth-setup.md).
 * Recharges use the mock payment simulator; no real money is involved.
 */
const DB = 'postgresql://himanshi@localhost:5432/campuscart_e2e';
const API_PORT = 4100;
const WEB_PORT = 5174;

const backendEnv = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? DB,
  PORT: String(API_PORT),
  FRONTEND_URL: `http://localhost:${WEB_PORT}`,
  BACKEND_URL: `http://localhost:${API_PORT}`,
  DEV_LOGIN_ENABLED: 'true',
  PAYMENT_MOCK_ENABLED: 'true',
  MANAGER_ALLOWED_EMAILS: 'e2e.manager@example.com',
  POS_ALLOWED_EMAILS: 'e2e.cashier@example.com',
  AUTH_RATE_LIMIT_MAX: '10000',
  MONEY_RATE_LIMIT_PER_MIN: '10000',
  ORDER_CAPACITY_PER_WINDOW: '10000',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // one shared database
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: 'chrome', // the locally installed Google Chrome; no browser download
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run start:e2e',
      cwd: '../backend',
      env: backendEnv,
      url: `http://localhost:${API_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      env: { CAMPUSCART_BACKEND_URL: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

export { backendEnv };
