/**
 * Development seed: `npm run db:seed -w backend`
 *
 * Adds clearly labelled SAMPLE outlets and menus to the development database.
 * Refuses to run unless NODE_ENV=development and the database name ends in "_dev".
 */
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { recordAudit } from '../src/lib/audit.js';
import { assignExistingStaffToSamples, seedSampleData } from '../src/scripts/sample-data.js';

async function main() {
  const databaseName = new URL(env.DATABASE_URL).pathname.replace(/^\//, '');
  if (env.NODE_ENV !== 'development' || !databaseName.endsWith('_dev')) {
    throw new Error(
      `Refusing to seed: sample data is only for development databases (NODE_ENV=${env.NODE_ENV}, database=${databaseName}).`,
    );
  }

  const summary = await seedSampleData(prisma);
  const assignments = await assignExistingStaffToSamples(prisma);
  if (summary.outletsCreated + summary.itemsCreated + assignments.length > 0) {
    await recordAudit(prisma, {
      actor: { type: 'CLI' },
      action: 'SAMPLE_DATA_SEEDED',
      entityType: 'Database',
      entityId: databaseName,
      metadata: { ...summary, staffAssignments: assignments },
    });
  }

  console.log(
    `Sample data: ${summary.outletsCreated} outlet(s), ${summary.categoriesCreated} categor(ies), ` +
      `${summary.itemsCreated} item(s) created (existing rows left unchanged).`,
  );
  console.log(
    assignments.length > 0
      ? `Assigned existing staff to sample outlets:\n  ${assignments.join('\n  ')}`
      : 'No new staff assignments (only users who already hold Manager/POS are assigned).',
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
