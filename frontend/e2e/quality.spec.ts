import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

/*
 * Every screen, as each role, at phone / tablet / laptop widths:
 *  - no horizontal scrolling (content wider than the screen)
 *  - no serious or critical WCAG 2.1 A/AA problems found by axe-core
 * axe is automated; it cannot judge everything (e.g. reading order), so
 * passing it is necessary, not sufficient.
 */

const WIDTHS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
];

interface Screens {
  who: string | null;
  paths: string[];
  /** Runs after sign-in, before the sweep: puts the account in the state the screens need. */
  prepare?: (page: Page) => Promise<void>;
}

const SCREENS: Screens[] = [
  {
    who: null,
    paths: ['/', '/menu', '/outlets/night-owl-cafe', '/outlets/juice-junction', '/login'],
  },
  {
    who: 'e2e.quality.student@example.com',
    // A dish in the cart, so /cart and /checkout show the real screens and not empty states.
    prepare: async (page) => {
      await page.goto('/outlets/night-owl-cafe');
      // The menu re-renders as its data arrives, so settle first: clicking mid-render
      // detaches the button from under the click. The three width runs share one
      // account, so on later runs the dish is already in the cart and the "Add" button
      // has become a quantity stepper — then there is nothing to click.
      await settle(page);
      const add = page.getByRole('button', { name: 'Add Filter coffee to cart' });
      if (await add.isVisible()) await add.click();
      await expect(page.getByRole('link', { name: /^Cart \d+ item/ })).toBeVisible();
    },
    paths: [
      '/cart',
      '/checkout',
      '/orders',
      '/wallet',
      '/profile',
      '/surprise',
      '/reviews',
      '/groups',
      '/groups/banquets/new',
      '/menu?sort=quick-reorder',
    ],
  },
  {
    who: 'e2e.manager@example.com',
    paths: [
      '/manage',
      '/manage/menu',
      '/manage/stock',
      '/manage/planner',
      '/manage/banquets',
      '/manage/outlet',
      '/manage/specials',
      '/manage/reviews',
      '/manage/kitchen',
    ],
  },
  {
    who: 'e2e.cashier@example.com',
    paths: ['/pos', '/pos/stock', '/pos/planner', '/pos/banquets', '/pos/history'],
  },
  {
    who: 'e2e.admin@example.com',
    paths: ['/admin', '/admin/outlets', '/admin/no-shows', '/admin/audit'],
  },
];

const STAFF = new Set(['e2e.manager@example.com', 'e2e.cashier@example.com']);

/*
 * Staff boards are checked with a live order on them — an empty board hides the order cards,
 * which is where label/name problems showed up before. A throwaway student places a
 * pay-at-counter order first and cancels it afterwards, so other specs see an empty board.
 */
async function placeOpenOrder(page: Page): Promise<{ code: string; url: string }> {
  await signIn(page, `e2e.quality.board.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  await page.getByRole('button', { name: 'Add Filter coffee to cart' }).click();
  await page.goto('/checkout');
  await page.getByRole('radio', { name: /Pay at the counter/ }).check();
  await page.getByRole('button', { name: 'Place order · ₹30' }).click();
  await expect(page.getByText(/Pay ₹30 at the counter/)).toBeVisible();
  return {
    code: (await page.locator('p.font-display').first().innerText()).trim(),
    url: page.url(),
  };
}

async function cancelOrder(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('This order was cancelled.')).toBeVisible();
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** Overflow and accessibility checks for whatever is on screen right now. */
async function auditScreen(page: Page, label: string, problems: string[]) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 0) problems.push(`${label}: ${overflow}px wider than the screen`);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  for (const v of results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )) {
    problems.push(
      `${label}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length}×: ${v.nodes
        .slice(0, 2)
        .map((n) => n.target.join(' '))
        .join(' | ')})`,
    );
  }
}

for (const { who, paths, prepare } of SCREENS) {
  test.describe(who ?? 'signed out', () => {
    for (const size of WIDTHS) {
      test(`${size.name} (${size.width}px): no sideways scroll, no serious accessibility issues`, async ({
        page,
        browser,
      }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        const shopper = who && STAFF.has(who) ? await browser.newPage() : null;
        const order = shopper ? await placeOpenOrder(shopper) : null;
        const problems: string[] = [];

        try {
          if (who) await signIn(page, who);
          if (prepare) await prepare(page);
          for (const path of paths) {
            await page.goto(path);
            await settle(page);
            if (order && (path === '/manage' || path === '/pos'))
              await expect(
                page.getByRole('article', { name: `Order ${order.code}` }),
              ).toBeVisible();

            await auditScreen(page, path, problems);
          }
        } finally {
          // Leave the board empty for later specs even if a check above failed.
          if (shopper && order) await cancelOrder(shopper, order.url);
          await shopper?.context().close();
        }
        expect(problems, problems.join('\n')).toEqual([]);
      });
    }
  });
}

/*
 * The dish page's URL carries a menu item's id, so it cannot be a fixed path like the
 * screens above. The sweep reaches it the way a student does: from the campus menu.
 */
test.describe('dish detail', () => {
  for (const size of WIDTHS) {
    test(`${size.name} (${size.width}px): no sideways scroll, no serious accessibility issues`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const problems: string[] = [];

      await page.goto('/menu');
      await settle(page);
      await page.getByRole('listitem').first().getByRole('link').first().click();
      await expect(page).toHaveURL(/\/outlets\/[^/]+\/items\//);
      await settle(page);

      await auditScreen(page, 'dish detail', problems);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
});
