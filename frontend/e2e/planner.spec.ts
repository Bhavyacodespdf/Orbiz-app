import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Weekly Stock Planner end to end against the real backend: a cashier generates next week's
 * plan from the e2e database's real (sparse) history, changes a quantity with a reason and
 * submits it; the manager approves it.
 */

test('a cashier plans next week’s stock and the manager approves it', async ({ browser }) => {
  const cashier = await (await browser.newContext()).newPage();
  await signIn(cashier, 'e2e.cashier@example.com', '/pos/planner');
  await expect(cashier.getByRole('heading', { name: 'Weekly Stock Planner' })).toBeVisible();
  await expect(cashier.getByText(/Forecasts are estimates, not guaranteed sales/)).toBeVisible();

  await cashier
    .getByRole('button', { name: /Generate forecast and plan|Refresh forecast/ })
    .click();
  const chaiRow = cashier.getByRole('row').filter({ hasText: 'Masala chai' }).first();
  await expect(chaiRow).toBeVisible();
  await expect(cashier.getByText('Draft · v', { exact: false })).toBeVisible();

  // Open the explanation.
  await chaiRow.getByRole('button', { name: /^Masala chai/ }).click();
  await expect(cashier.getByRole('list', { name: 'Daily forecast for Masala chai' })).toBeVisible();

  // Change the quantity: a reason is required.
  await cashier.getByRole('button', { name: 'Change quantity for Masala chai' }).click();
  const dialog = cashier.getByRole('dialog', { name: 'Quantity for Masala chai' });
  await dialog.getByLabel('Final quantity').fill('40');
  await expect(dialog.getByRole('button', { name: 'Save quantity' })).toBeDisabled();
  await dialog.getByLabel(/Reason for the change/).fill('Fresher’s week event');
  await dialog.getByRole('button', { name: 'Save quantity' }).click();
  await expect(dialog).toBeHidden();
  await expect(chaiRow).toContainText('40');
  await expect(chaiRow).toContainText('Changed');

  await expect(cashier.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
  await cashier.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(cashier.getByText('Submitted for approval · v', { exact: false })).toBeVisible();

  const manager = await (await browser.newContext()).newPage();
  await signIn(manager, 'e2e.manager@example.com', '/manage/planner');
  await manager.getByRole('button', { name: 'Approve plan' }).click();
  await expect(manager.getByText('Approved · v', { exact: false })).toBeVisible();
  await expect(manager.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  // The original recommendation and the reason for the change are both kept.
  await manager
    .getByRole('row')
    .filter({ hasText: 'Masala chai' })
    .first()
    .getByRole('button', { name: /^Masala chai/ })
    .click();
  await expect(
    manager.getByRole('paragraph').filter({ hasText: 'Changed by staff' }),
  ).toContainText('to 40: “Fresher’s week event”');
});
