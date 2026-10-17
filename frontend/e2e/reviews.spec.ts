import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn, pickupCodeOf, verifyAndHandOver } from './helpers';

/*
 * Food ratings on the real backend: a student collects a counter order, rates the dish from the
 * order page, sees the verified review and the new rating on the menu, edits it, and the manager
 * sees it in the outlet's reviews. Cleans up after itself (the review is deleted at the end).
 */

async function seriousA11yIssues(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test('a student rates a dish they collected and the rating shows everywhere', async ({
  browser,
}) => {
  const student = await (await browser.newContext()).newPage();
  const cashier = await (await browser.newContext()).newPage();
  const manager = await (await browser.newContext()).newPage();

  // Before buying: the dish is unrated and the student can't rate it.
  await signIn(student, `e2e.reviewer.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  await expect(
    student.getByRole('link', { name: 'Not yet rated. See reviews' }).first(),
  ).toBeVisible();
  await student.getByRole('link', { name: 'Filter coffee', exact: true }).click();
  await expect(student.getByRole('heading', { name: 'Filter coffee', level: 1 })).toBeVisible();
  await expect(student.getByText('Be the first to rate this item')).toBeVisible();
  await expect(
    student.getByText('You can rate this dish after you’ve collected an order with it.'),
  ).toBeVisible();

  // Order and collect it at the counter.
  await student.getByRole('button', { name: 'Add Filter coffee to cart' }).click();
  await student.goto('/checkout');
  await student.getByRole('radio', { name: /Pay at the counter/ }).check();
  await student.getByRole('button', { name: 'Place order · ₹30' }).click();
  await expect(student.getByText(/Pay ₹30 at the counter/)).toBeVisible();
  const code = (await student.locator('p.font-display').first().innerText()).trim();
  const orderUrl = student.url();

  await signIn(cashier, 'e2e.cashier@example.com', '/pos');
  const ticket = cashier.getByRole('article', { name: `Order ${code}` });
  for (const button of ['Accept', 'Start preparing', 'Mark ready'])
    await ticket.getByRole('button', { name: button }).click();
  await ticket.getByRole('button', { name: 'Take ₹30' }).click();
  const dialog = cashier.getByRole('dialog', { name: `Order ${code}` });
  await dialog.getByRole('button', { name: 'Record counter payment' }).click();
  await dialog.getByRole('button', { name: 'Confirm ₹30 received' }).click();
  await dialog.getByRole('button', { name: 'Verify pickup' }).click();
  await verifyAndHandOver(cashier, await pickupCodeOf(student), {
    orderNumber: code,
    dialogOpen: true,
  });

  // Rate it from the order page.
  await student.goto(orderUrl);
  await student.getByRole('link', { name: 'Rate Filter coffee' }).click();
  await student.getByRole('button', { name: 'Rate food' }).click();
  const form = student.getByRole('dialog', { name: 'Rate this dish' });
  await form.locator('label').filter({ hasText: '5 stars: Excellent' }).click();
  await form.getByRole('group', { name: 'Taste' }).getByText('Great').click();
  await form.getByLabel(/Your review/).fill('Strong, hot and fresh.');
  await form.getByRole('button', { name: 'Submit review' }).click();
  await expect(student.getByText('Thanks for your review')).toBeVisible();

  const reviews = student.getByRole('region', { name: /Reviews/ });
  await expect(reviews.getByText('Strong, hot and fresh.')).toBeVisible();
  await expect(reviews.getByText('Verified Purchase')).toBeVisible();
  await expect(student.getByText('Rated 5.0 out of 5 from 1 rating').first()).toBeAttached();
  expect(await seriousA11yIssues(student)).toEqual([]);

  // Edit: the same review changes; still one rating.
  await student.getByRole('button', { name: 'Edit' }).click();
  const edit = student.getByRole('dialog', { name: 'Edit your review' });
  await edit.locator('label').filter({ hasText: '4 stars: Good' }).click();
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(student.getByText('Review updated')).toBeVisible();
  await expect(student.getByText('Rated 4.0 out of 5 from 1 rating').first()).toBeAttached();

  // The menu shows the real rating.
  await student.goto('/outlets/night-owl-cafe');
  await expect(
    student.getByRole('link', { name: 'Rated 4.0 out of 5 from 1 rating. See reviews' }),
  ).toBeVisible();

  // The manager sees it in the outlet's reviews.
  await signIn(manager, 'e2e.manager@example.com', '/manage/reviews');
  await expect(manager.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
  await expect(manager.getByText('Strong, hot and fresh.').first()).toBeVisible();
  expect(await seriousA11yIssues(manager)).toEqual([]);

  // My reviews, then clean up.
  await student.goto('/reviews');
  await expect(student.getByRole('link', { name: 'Filter coffee' })).toBeVisible();
  expect(await seriousA11yIssues(student)).toEqual([]);
  await student.getByRole('button', { name: 'Delete your review of Filter coffee' }).click();
  await student
    .getByRole('dialog', { name: 'Delete your review?' })
    .getByRole('button', { name: 'Delete review' })
    .click();
  await expect(student.getByText('No reviews yet')).toBeVisible();

  for (const p of [student, cashier, manager]) await p.context().close();
});
