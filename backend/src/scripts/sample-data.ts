import type { DbClient } from '../lib/prisma.js';
import type { Dietary, OutletStatus } from '../generated/prisma/enums.js';

/**
 * DEVELOPMENT SAMPLE DATA. Fictional outlets and menus for local development
 * and demos. Every outlet is stored with isSample = true and shown with a
 * "Sample data" label. Prices are illustrative, not real canteen prices.
 *
 * Deliberately NOT seeded: users, roles, wallet balances, orders, payments.
 */

interface SampleItem {
  name: string;
  description: string;
  rupees: number;
  dietary: Dietary;
  available?: boolean;
}

interface SampleOutlet {
  slug: string;
  name: string;
  description: string;
  location: string;
  status: OutletStatus;
  menu: Record<string, SampleItem[]>;
}

export const SAMPLE_OUTLETS: SampleOutlet[] = [
  {
    slug: 'night-owl-cafe',
    name: 'Night Owl Café',
    description: 'Late-night chai, coffee and quick bites for study sessions.',
    location: 'Library block, ground floor',
    status: 'OPEN',
    menu: {
      'Hot drinks': [
        {
          name: 'Masala chai',
          description: 'Ginger, cardamom, full-cream milk.',
          rupees: 20,
          dietary: 'VEG',
        },
        {
          name: 'Filter coffee',
          description: 'South Indian decoction coffee.',
          rupees: 30,
          dietary: 'VEG',
        },
        {
          name: 'Hot chocolate',
          description: 'Thick and not too sweet.',
          rupees: 60,
          dietary: 'VEG',
        },
      ],
      Snacks: [
        {
          name: 'Vada pav',
          description: 'Spiced potato fritter, chutneys, soft pav.',
          rupees: 25,
          dietary: 'VEG',
        },
        {
          name: 'Veg puff',
          description: 'Flaky pastry, mixed-veg masala.',
          rupees: 30,
          dietary: 'VEG',
        },
        {
          name: 'Egg puff',
          description: 'Flaky pastry, half egg, onion masala.',
          rupees: 35,
          dietary: 'EGG',
        },
        {
          name: 'Chicken sandwich',
          description: 'Grilled, with mint mayo.',
          rupees: 80,
          dietary: 'NON_VEG',
          available: false,
        },
      ],
    },
  },
  {
    slug: 'tandoor-corner',
    name: 'Tandoor Corner',
    description: 'North Indian thalis, rolls and tandoor breads.',
    location: 'Central food court, counter 3',
    status: 'OPEN',
    menu: {
      Rolls: [
        {
          name: 'Paneer tikka roll',
          description: 'Charred paneer, onions, green chutney.',
          rupees: 90,
          dietary: 'VEG',
        },
        {
          name: 'Egg roll',
          description: 'Double egg paratha, onions, sauces.',
          rupees: 60,
          dietary: 'EGG',
        },
        {
          name: 'Chicken tikka roll',
          description: 'Tandoori chicken, pickled onion.',
          rupees: 110,
          dietary: 'NON_VEG',
        },
      ],
      Meals: [
        {
          name: 'Veg thali',
          description: 'Dal, sabzi, rice, 2 rotis, salad.',
          rupees: 120,
          dietary: 'VEG',
        },
        {
          name: 'Rajma chawal',
          description: 'Kidney-bean curry with steamed rice.',
          rupees: 90,
          dietary: 'VEG',
        },
        {
          name: 'Butter chicken with naan',
          description: 'Two butter naans.',
          rupees: 180,
          dietary: 'NON_VEG',
        },
      ],
    },
  },
  {
    slug: 'juice-junction',
    name: 'Juice Junction',
    description: 'Fresh juices and shakes. Currently closed for the evening.',
    location: 'Sports complex entrance',
    status: 'CLOSED',
    menu: {
      Juices: [
        {
          name: 'Fresh lime soda',
          description: 'Sweet, salted or mixed.',
          rupees: 40,
          dietary: 'VEG',
        },
        { name: 'Watermelon juice', description: 'No added sugar.', rupees: 50, dietary: 'VEG' },
      ],
      Shakes: [
        {
          name: 'Banana shake',
          description: 'Banana, milk, a little honey.',
          rupees: 60,
          dietary: 'VEG',
        },
        {
          name: 'Cold coffee',
          description: 'With a scoop of vanilla ice cream.',
          rupees: 80,
          dietary: 'VEG',
        },
      ],
    },
  },
];

export interface SeedSummary {
  outletsCreated: number;
  categoriesCreated: number;
  itemsCreated: number;
}

/**
 * Creates any missing sample outlets, categories and items. Safe to run
 * repeatedly: existing rows are left untouched, so edits made in the app
 * (prices, availability, status) are never overwritten.
 */
export async function seedSampleData(db: DbClient): Promise<SeedSummary> {
  const summary: SeedSummary = { outletsCreated: 0, categoriesCreated: 0, itemsCreated: 0 };

  for (const sample of SAMPLE_OUTLETS) {
    let outlet = await db.outlet.findUnique({ where: { slug: sample.slug } });
    if (!outlet) {
      outlet = await db.outlet.create({
        data: {
          slug: sample.slug,
          name: sample.name,
          description: sample.description,
          location: sample.location,
          status: sample.status,
          isSample: true,
        },
      });
      summary.outletsCreated++;
    }

    let categoryOrder = 0;
    for (const [categoryName, items] of Object.entries(sample.menu)) {
      categoryOrder += 10;
      let category = await db.menuCategory.findUnique({
        where: { outletId_name: { outletId: outlet.id, name: categoryName } },
      });
      if (!category) {
        category = await db.menuCategory.create({
          data: { outletId: outlet.id, name: categoryName, sortOrder: categoryOrder },
        });
        summary.categoriesCreated++;
      }

      let itemOrder = 0;
      for (const item of items) {
        itemOrder += 10;
        const exists = await db.menuItem.findUnique({
          where: { outletId_name: { outletId: outlet.id, name: item.name } },
          select: { id: true },
        });
        if (exists) continue;
        await db.menuItem.create({
          data: {
            outletId: outlet.id,
            categoryId: category.id,
            name: item.name,
            description: item.description,
            pricePaise: item.rupees * 100,
            dietary: item.dietary,
            isAvailable: item.available ?? true,
            sortOrder: itemOrder,
          },
        });
        summary.itemsCreated++;
      }
    }
  }
  return summary;
}

/**
 * Development convenience: gives every user who ALREADY holds the Manager or
 * POS role an assignment to each sample outlet. Never creates users or roles.
 */
export async function assignExistingStaffToSamples(db: DbClient): Promise<string[]> {
  const staffRoles = await db.userRole.findMany({
    where: { role: { in: ['MANAGER', 'POS'] }, revokedAt: null, user: { status: 'ACTIVE' } },
    include: { user: { select: { email: true } } },
  });
  const outlets = await db.outlet.findMany({ where: { isSample: true }, select: { id: true } });
  const created: string[] = [];

  for (const { userId, role, user } of staffRoles) {
    const staffRole = role === 'MANAGER' ? 'MANAGER' : 'POS';
    for (const outlet of outlets) {
      const existing = await db.staffAssignment.findUnique({
        where: { userId_outletId_role: { userId, outletId: outlet.id, role: staffRole } },
      });
      if (existing) continue;
      await db.staffAssignment.create({ data: { userId, outletId: outlet.id, role: staffRole } });
      created.push(`${user.email} → ${staffRole}`);
    }
  }
  return [...new Set(created)];
}
