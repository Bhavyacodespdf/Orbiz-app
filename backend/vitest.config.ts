import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests always run against .env.test (the isolated campuscart_test database).
const testEnv = config({ path: '.env.test', quiet: true }).parsed ?? {};

export default defineConfig({
  test: {
    environment: 'node',
    env: testEnv,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    // Test files share one database and reset it between tests, so run them one at a time.
    fileParallelism: false,
  },
});
