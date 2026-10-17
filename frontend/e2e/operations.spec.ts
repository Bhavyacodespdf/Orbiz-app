import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

/*
 * Notifications, live tracking and kitchen timing on the real backend: a manager configures a
 * preparation time, a student's order shows its queue estimate and live progress, the inbox
 * receives the real lifecycle notifications, and the order is cleaned up afterwards.
 */

async function seriousA11yIssues(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test('an order is tracked live with an estimate and real notifications', async ({ browser }) => {
  const manager = await (await browser.newContext()).newPage();
  const student = await (await browser.newContext()).newPage();
  const cashier = await (await browser.newContext()).newPage();

  // The manager configures how long filter coffee takes.
  await signIn(manager, 'e2e.manager@example.com', '/manage/kitchen');
  await expect(manager.getByRole('heading', { name: 'Kitchen timing', level: 1 })).toBeVisible();
  const field = manager.getByLabel('Configured Preparation Time for Filter coffee (minutes)');
  await field.fill('4');
  await manager.getByRole('button', { name: 'Save preparation time for Filter coffee' }).click();
  await expect(manager.getByText('Filter coffee: preparation time saved')).toBeVisible();
  expect(await seriousA11yIssues(manager)).toEqual([]);

  // The student orders; the page shows where it is in the queue.
  await signIn(student, `e2e.ops.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  await student.getByRole('button', { name: 'Add Filter coffee to cart' }).click();
  await student.goto('/checkout');
  await student.getByRole('radio', { name: /Pay at the counter/ }).check();
  await student.getByRole('button', { name: 'Place order · ₹30' }).click();
  await expect(student.getByText(/Pay ₹30 at the counter/)).toBeVisible();
  const code = (await student.locator('p.font-display').first().innerText()).trim();
  await expect(student.getByText(/Estimated ready around/)).toBeVisible();

  // Staff accept and start preparing: progress and estimate update live.
  await signIn(cashier, 'e2e.cashier@example.com', '/pos');
  const ticket = cashier.getByRole('article', { name: `Order ${code}` });
  await expect(ticket.getByText(/ready ~/)).toBeVisible();
  await ticket.getByRole('button', { name: 'Accept' }).click();
  await ticket.getByRole('button', { name: 'Start preparing' }).click();
  await expect(student.getByText('Being prepared now')).toBeVisible();

  // The inbox holds the real lifecycle notifications.
  await student.getByRole('button', { name: /^Notifications, \d+ unread/ }).click();
  const inbox = student.getByRole('dialog', { name: 'Notifications' });
  await expect(inbox.getByText(`Order ${code} is being prepared`)).toBeVisible();
  await expect(inbox.getByText(`Order ${code} accepted`)).toBeVisible();
  await expect(inbox.getByText(`Order ${code} placed`)).toBeVisible();
  expect(await seriousA11yIssues(student)).toEqual([]);
  await inbox.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(student.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await inbox.getByRole('button', { name: 'Close dialog' }).click();

  // Clean up: the manager cancels it (with a reason) so the board is empty for other specs.
  await manager.goto('/manage');
  await manager.getByRole('button', { name: new RegExp(`^Open order ${code}`) }).click();
  const dialog = manager.getByRole('dialog', { name: `Order ${code}` });
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await dialog.getByLabel(/Reason for the student/).fill('E2E clean-up');
  await dialog.getByRole('button', { name: 'Confirm: Cancel order' }).click();
  await expect(
    student.getByText(/This order was cancelled|The outlet cancelled/).first(),
  ).toBeVisible();

  // Reset the configured time.
  await manager.goto('/manage/kitchen');
  await manager.getByLabel('Configured Preparation Time for Filter coffee (minutes)').fill('');
  await manager.getByRole('button', { name: 'Save preparation time for Filter coffee' }).click();

  for (const p of [manager, student, cashier]) await p.context().close();
});
