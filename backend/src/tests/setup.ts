// Safety guard: automated tests may only ever touch a database whose name ends in "_test".
const url = process.env.DATABASE_URL ?? '';
const databaseName = new URL(url).pathname.replace(/^\//, '');

if (process.env.NODE_ENV !== 'test' || !databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests: NODE_ENV must be "test" and the database name must end in "_test" (got "${databaseName}").`,
  );
}

import { afterAll } from 'vitest';

afterAll(async () => {
  const { prisma } = await import('../lib/prisma.js');
  await prisma.$disconnect();
});
