import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn, pickupCodeOf, verifyAndHandOver } from './helpers';

/*
 * Quick Reorder on the real backend: a student collects an order, reorders it from the home page
 * in one tap, reviews the tray and checks out through the normal checkout. The new order is then
 * cancelled so the outlet's board is left empty for other specs.
 */

async function seriousA11yIssues(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test('a student reorders a collected meal in one tap and checks out normally', async ({
  browser,
}) => {
  const student = await (await browser.newContext()).newPage();
  const cashier = await (await browser.newContext()).newPage();

  // A first order, collected at the counter.
  await signIn(student, `e2e.reorder.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  await student.getByRole('button', { name: 'Add Filter coffee to cart' }).click();
  await student.getByRole('button', { name: 'One more Filter coffee' }).click();
  await student.goto('/checkout');
  await student.getByRole('radio', { name: /Pay at the counter/ }).check();
  await student.getByRole('button', { name: 'Place order · ₹60' }).click();
  await expect(student.getByText(/Pay ₹60 at the counter/)).toBeVisible();
  const code = (await student.locator('p.font-display').first().innerText()).trim();

  await signIn(cashier, 'e2e.cashier@example.com', '/pos');
  const ticket = cashier.getByRole('article', { name: `Order ${code}` });
  for (const button of ['Accept', 'Start preparing', 'Mark ready'])
    await ticket.getByRole('button', { name: button }).click();
  await ticket.getByRole('button', { name: 'Take ₹60' }).click();
  const dialog = cashier.getByRole('dialog', { name: `Order ${code}` });
  await dialog.getByRole('button', { name: 'Record counter payment' }).click();
  await dialog.getByRole('button', { name: 'Confirm ₹60 received' }).click();
  await dialog.getByRole('button', { name: 'Verify pickup' }).click();
  await verifyAndHandOver(cashier, await pickupCodeOf(student), {
    orderNumber: code,
    dialogOpen: true,
  });

  // Home: the meal is ready to reorder, from real history.
  await student.goto('/');
  const section = student.getByRole('region', { name: 'Quick reorder' });
  const card = section.getByRole('article').first();
  await expect(card.getByText('Filter coffee × 2')).toBeVisible();
  await expect(card.getByText(/Night Owl Café/)).toBeVisible();
  await expect(card.getByText('Available now')).toBeVisible();
  expect(await seriousA11yIssues(student)).toEqual([]);

  await card.getByRole('button', { name: /^Reorder your previous/ }).click();
  const added = student.getByRole('dialog', { name: 'Added to your tray' });
  await expect(added.getByText('Filter coffee × 2')).toBeVisible();
  await added.getByRole('link', { name: /Review tray/ }).click();
  await expect(student).toHaveURL(/\/cart$/);
  await expect(student.getByText('Filter coffee').first()).toBeVisible();

  // Normal checkout: nothing was charged or ordered by the reorder itself.
  await student.goto('/checkout');
  await student.getByRole('radio', { name: /Pay at the counter/ }).check();
  await student.getByRole('button', { name: 'Place order · ₹60' }).click();
  await expect(student.getByText(/Pay ₹60 at the counter/)).toBeVisible();

  // Clean up: cancel the new order (still PLACED).
  await student.getByRole('button', { name: 'Cancel order' }).click();
  await student.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
  await expect(student.getByText('This order was cancelled.')).toBeVisible();

  for (const p of [student, cashier]) await p.context().close();
});
