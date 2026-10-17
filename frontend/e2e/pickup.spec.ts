import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { pickupCodeOf, signIn } from './helpers';

/*
 * Secure pickup on the real backend: the code appears only when the order is ready, staff verify
 * it and must confirm, the student then sees "Order collected", and the same code can't be used
 * again. (Camera scanning needs a real camera; the numeric code exercises the same server checks.)
 */

async function seriousA11yIssues(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test('a ready order is released only after its pickup code is verified and confirmed, once', async ({
  browser,
}) => {
  const student = await (await browser.newContext()).newPage();
  const cashier = await (await browser.newContext()).newPage();

  await signIn(student, `e2e.pickup.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  await student.getByRole('button', { name: 'Add Filter coffee to cart' }).click();
  await student.goto('/checkout');
  await student.getByRole('radio', { name: /Pay at the counter/ }).check();
  await student.getByRole('button', { name: 'Place order · ₹30' }).click();
  await expect(student.getByText(/Pay ₹30 at the counter/)).toBeVisible();
  const orderNumber = (await student.locator('p.font-display').first().innerText()).trim();
  await expect(
    student.getByText('Your pickup code will appear here when your order is ready.'),
  ).toBeVisible();

  await signIn(cashier, 'e2e.cashier@example.com', '/pos');
  const ticket = cashier.getByRole('article', { name: `Order ${orderNumber}` });
  for (const button of ['Accept', 'Start preparing', 'Mark ready'])
    await ticket.getByRole('button', { name: button }).click();

  // The student's screen switches to the QR and code by itself.
  const panel = student.getByRole('region', { name: 'Ready for pickup' });
  await expect(
    panel.getByRole('img', { name: `Pickup QR code for order ${orderNumber}` }),
  ).toBeVisible();
  const code = await pickupCodeOf(student);
  expect(code).toMatch(/^\d{6}$/);
  expect(await seriousA11yIssues(student)).toEqual([]);

  // Take the counter payment, then verify: the matched order shows, nothing is released yet.
  await ticket.getByRole('button', { name: 'Take ₹30' }).click();
  const orderDialog = cashier.getByRole('dialog', { name: `Order ${orderNumber}` });
  await orderDialog.getByRole('button', { name: 'Record counter payment' }).click();
  await orderDialog.getByRole('button', { name: 'Confirm ₹30 received' }).click();
  await orderDialog.getByRole('button', { name: 'Verify pickup' }).click();

  const verify = cashier.getByRole('dialog', { name: 'Verify pickup' });
  await verify.getByLabel('Student’s pickup code').fill(code);
  await verify.getByRole('button', { name: 'Verify code' }).click();
  await expect(verify.getByText(orderNumber, { exact: true })).toBeVisible();
  await expect(verify.getByRole('list', { name: 'Items' })).toContainText('Filter coffee');
  expect(await seriousA11yIssues(cashier)).toEqual([]);
  await expect(panel).toBeVisible(); // still ready: verification alone released nothing

  await verify.getByRole('button', { name: 'Confirm handover' }).click();
  await expect(verify.getByText(new RegExp(`${orderNumber} handed over at`))).toBeVisible();
  await expect(student.getByRole('region', { name: 'Order collected' })).toBeVisible();
  await expect(student.locator('[aria-label^="Pickup code "]')).toHaveCount(0);

  // The same code again: refused.
  await verify.getByRole('button', { name: 'Verify another' }).click();
  await verify.getByLabel('Student’s pickup code').fill(code);
  await verify.getByRole('button', { name: 'Verify code' }).click();
  await expect(verify.getByRole('alert')).toContainText('No ready order at this outlet matches');

  for (const p of [student, cashier]) await p.context().close();
});
