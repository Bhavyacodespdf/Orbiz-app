import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Reads backend/.env by default. Set ENV_FILE=.env.test to target the test database.
config({ path: process.env.ENV_FILE ?? '.env', quiet: true });

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Generating the client (which `npm install` does) needs no database, so the URL is
  // only required by commands that connect — they fail with a clear message without it.
  ...(url && { datasource: { url } }),
});
