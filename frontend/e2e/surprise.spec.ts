import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Surprise Meal against the real backend and the sample menu in the e2e database:
 * every combo is within budget, Veg means vegetarian dishes only, a swap keeps the
 * rest, and the combo lands in the normal cart at server prices.
 */

const rupeesToPaise = (text: string) => Number(text.replace(/[^\d]/g, '')) * 100;

test('budget-safe combos, swaps and adding to the tray', async ({ page }) => {
  await signIn(page, `e2e.surprise.${Date.now()}@example.com`, '/surprise');
  const card = page.getByRole('region', { name: /Recommended combo/ });
  await expect(card).toBeVisible();

  // Every preset and mood gives a combo within budget (or an honest "no combo").
  for (const preset of ['₹80 Snack', '₹140 Lunch', '₹300 Feast']) {
    await page.getByRole('button', { name: preset }).click();
    for (const mood of ['Quick Bite', 'Feast Combo']) {
      await page.getByText(mood, { exact: true }).click();
      await expect(page.getByRole('radio', { name: new RegExp(mood) })).toBeChecked();
      const budget = rupeesToPaise(preset.split(' ')[0]!);
      await expect(card).toContainText(
        new RegExp(`under your ₹${budget / 100} budget|Budget fully used`),
      );
      const total = rupeesToPaise(await card.locator('p.font-display').innerText());
      expect(total).toBeLessThanOrEqual(budget);
    }
  }

  // Veg only: every dish carries the vegetarian mark.
  await page.getByText('Veg', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Veg', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Re-spin Surprise Combo' }).click();
  await expect(card.getByRole('img', { name: 'Non-vegetarian' })).toHaveCount(0);
  await expect(card.getByRole('img', { name: 'Contains egg' })).toHaveCount(0);

  // Swap one dish: the others stay. Wait for the combo for the new diet before reading it.
  const regenerated = page.waitForResponse(
    (r) => r.url().endsWith('/surprise-meal/generate') && r.request().method() === 'POST',
  );
  await page.getByText('Any', { exact: true }).click();
  await regenerated;
  await page.getByRole('button', { name: '₹300 Feast' }).click();
  await page.getByText('Feast Combo', { exact: true }).click();
  const dishes = card.getByRole('list', { name: 'Dishes in this combo' }).getByRole('listitem');
  await expect(dishes.first()).toBeVisible();
  const before = await dishes.allInnerTexts();
  if (before.length > 1) {
    const keep = before.slice(1).map((t) => t.split('\n')[0]);
    const first = before[0]!.split('\n')[0]!;
    await card.getByRole('button', { name: `Swap ${first}` }).click();
    // Done when the dish changed, or the card explains that nothing else fits.
    await expect
      .poll(async () => {
        const now = await dishes.allInnerTexts();
        return now[0]!.split('\n')[0] !== first || (await card.getByRole('status').count()) > 0;
      })
      .toBe(true);
    await expect(card.getByRole('button', { name: /^Swap / }).first()).toBeEnabled();
    for (const name of keep) await expect(card).toContainText(name!);
  }

  // Add to the tray: the normal cart shows the same dishes at server prices.
  const total = await card.locator('p.font-display').innerText();
  await page.getByRole('button', { name: /Add Combo to Tray/ }).click();
  await expect(page.getByText(/^Combo added to your tray from /)).toBeVisible();
  await page.getByRole('link', { name: 'View tray' }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('main')).toContainText(total);
});
