import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Menu search and sorting on the real backend and seeded menus: price order really follows the
 * current prices, search narrows the list, and the controls fit a phone screen.
 */

/** The prices shown on the result rows, in order (₹30 / ₹35.50 → paise). */
async function shownPrices(page: Page): Promise<number[]> {
  const list = page.getByRole('list', { name: /^Dishes sorted by/ });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  const texts = await list.getByRole('listitem').locator('h3 + *').allInnerTexts();
  return texts.map((t) => Math.round(Number(t.replace(/[^\d.]/g, '')) * 100));
}

test('students search the campus menu and sort it by real prices', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, `e2e.menu.${Date.now()}@example.com`, '/menu');
  await expect(page.getByRole('heading', { name: 'Find something to eat' })).toBeVisible();

  await page.getByRole('button', { name: 'In stock only' }).click();
  await page.getByRole('button', { name: 'Price: Low to High' }).click();
  await expect(page.getByRole('button', { name: 'Price: Low to High' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(/sorted by Price: Low to High/)).toBeVisible();
  const ascending = await shownPrices(page);
  expect(ascending.length).toBeGreaterThan(1);
  expect(ascending).toEqual([...ascending].sort((a, b) => a - b));

  await page.getByRole('button', { name: 'Price: High to Low' }).click();
  await expect(page.getByText(/sorted by Price: High to Low/)).toBeVisible();
  const descending = await shownPrices(page);
  expect(descending).toEqual([...descending].sort((a, b) => b - a));

  // Search keeps the sort, matches part of a name in any case.
  await page.getByLabel('Search dishes, categories or outlets').fill('FILTER cof');
  const list = page.getByRole('list', { name: 'Dishes sorted by Price: High to Low' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Filter coffee');
  await expect(list).toContainText('Night Owl Café');

  // Nothing matches: a friendly empty state.
  await page.getByLabel('Search dishes, categories or outlets').fill('zzzz-no-such-dish');
  await expect(page.getByText('Nothing matches “zzzz-no-such-dish”')).toBeVisible();

  // The controls fit a phone: no sideways scrolling.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
