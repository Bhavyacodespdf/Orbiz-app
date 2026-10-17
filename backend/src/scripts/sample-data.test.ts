import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../tests/db.js';
import { signInWithIdentity } from '../modules/auth/provisioning.service.js';
import { assignExistingStaffToSamples, SAMPLE_OUTLETS, seedSampleData } from './sample-data.js';

beforeEach(resetDatabase);

describe('development sample data', () => {
  it('creates labelled sample outlets with valid integer-paise prices and no users or money', async () => {
    const summary = await seedSampleData(prisma);
    expect(summary.outletsCreated).toBe(SAMPLE_OUTLETS.length);
    const outlets = await prisma.outlet.findMany();
    expect(outlets.every((o) => o.isSample)).toBe(true);
    const items = await prisma.menuItem.findMany();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => Number.isInteger(i.pricePaise) && i.pricePaise > 0)).toBe(true);
    expect(await prisma.user.count()).toBe(0);
  });

  it('is safe to run twice and never overwrites edits made in the app', async () => {
    await seedSampleData(prisma);
    const chai = await prisma.menuItem.findFirstOrThrow({ where: { name: 'Masala chai' } });
    await prisma.menuItem.update({ where: { id: chai.id }, data: { pricePaise: 2500 } });
    const counts = async () => [await prisma.outlet.count(), await prisma.menuItem.count()];
    const before = await counts();

    const second = await seedSampleData(prisma);
    expect(second).toEqual({ outletsCreated: 0, categoriesCreated: 0, itemsCreated: 0 });
    expect(await counts()).toEqual(before);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: chai.id } })).pricePaise).toBe(
      2500,
    );
  });

  it('assigns only users who already hold Manager/POS, and never creates roles', async () => {
    await seedSampleData(prisma);
    await signInWithIdentity(
      prisma,
      {
        provider: 'DEV',
        subject: 'm@example.com',
        email: 'm@example.com',
        emailVerified: true,
        name: null,
        picture: null,
      },
      { MANAGER_ALLOWED_EMAILS: ['m@example.com'], POS_ALLOWED_EMAILS: [] },
    );
    await signInWithIdentity(
      prisma,
      {
        provider: 'DEV',
        subject: 's@example.com',
        email: 's@example.com',
        emailVerified: true,
        name: null,
        picture: null,
      },
      { MANAGER_ALLOWED_EMAILS: [], POS_ALLOWED_EMAILS: [] },
    );
    const rolesBefore = await prisma.userRole.count();
    await assignExistingStaffToSamples(prisma);
    expect(await prisma.staffAssignment.count()).toBe(SAMPLE_OUTLETS.length);
    expect(await prisma.userRole.count()).toBe(rolesBefore);
    expect(await assignExistingStaffToSamples(prisma)).toEqual([]);
  });
});
