/**
 * Prepares the END-TO-END TEST database before Playwright runs.
 * Refuses to touch any database whose name does not end in "_e2e".
 *
 * Builds a known starting point using the real service functions:
 * sample outlets/menus, plus developer-login accounts for a manager, a
 * cashier and an administrator, assigned to Night Owl Café.
 */
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { signInWithIdentity } from '../modules/auth/provisioning.service.js';
import { grantRole } from '../modules/users/roles.service.js';
import { seedSampleData } from './sample-data.js';

export const E2E_USERS = {
  manager: 'e2e.manager@example.com',
  cashier: 'e2e.cashier@example.com',
  admin: 'e2e.admin@example.com',
};

async function main() {
  const databaseName = new URL(env.DATABASE_URL).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_e2e')) {
    throw new Error(`Refusing to reset "${databaseName}": only *_e2e databases may be reset.`);
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }

  await seedSampleData(prisma);

  const lists = {
    MANAGER_ALLOWED_EMAILS: [E2E_USERS.manager],
    POS_ALLOWED_EMAILS: [E2E_USERS.cashier],
  };
  for (const email of Object.values(E2E_USERS)) {
    await signInWithIdentity(
      prisma,
      { provider: 'DEV', subject: email, email, emailVerified: true, name: null, picture: null },
      lists,
    );
  }
  await grantRole(prisma, {
    email: E2E_USERS.admin,
    role: 'ADMIN',
    actor: { type: 'CLI' },
    lists: { ...env, ...lists },
  });

  const nightOwl = await prisma.outlet.findUniqueOrThrow({ where: { slug: 'night-owl-cafe' } });
  const user = (email: string) => prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.staffAssignment.createMany({
    data: [
      { userId: (await user(E2E_USERS.manager)).id, outletId: nightOwl.id, role: 'MANAGER' },
      { userId: (await user(E2E_USERS.cashier)).id, outletId: nightOwl.id, role: 'POS' },
    ],
  });
  console.log(`E2E database "${databaseName}" reset.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
