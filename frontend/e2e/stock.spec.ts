import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Stock end to end: a manager starts counting an item, students see "Few left", an order
 * takes the last units so it shows "Sold out" to everyone, and a cashier restocks it.
 */

test('stock flows from the kitchen to the student menu and back', async ({ browser }) => {
  const managerPage = await (await browser.newContext()).newPage();
  await signIn(managerPage, 'e2e.manager@example.com', '/manage/stock');
  await managerPage.getByRole('button', { name: 'Stock settings for Veg puff' }).click();
  const settings = managerPage.getByRole('dialog', { name: 'Stock settings: Veg puff' });
  await settings.getByLabel('Units on hand').fill('2');
  await settings.getByLabel('Low stock at or below').fill('5');
  await settings.getByRole('button', { name: 'Start counting stock' }).click();
  const puffRow = managerPage.getByRole('listitem').filter({ hasText: 'Veg puff' });
  await expect(puffRow).toContainText('2 left');
  await expect(puffRow).toContainText('Low stock');

  // A student sees "Few left" and buys both.
  const buyer = await (await browser.newContext()).newPage();
  await signIn(buyer, `e2e.stock.buyer.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  const snacks = buyer.getByRole('region', { name: 'Snacks' });
  await expect(snacks.getByRole('listitem').filter({ hasText: 'Veg puff' })).toContainText(
    'Few left',
  );
  await buyer.getByRole('button', { name: 'Add Veg puff to cart' }).click();
  await buyer.getByRole('button', { name: 'One more Veg puff' }).click();
  await buyer.goto('/checkout');
  await buyer.getByRole('radio', { name: /Pay at the counter/ }).check();
  await buyer.getByRole('button', { name: /Place order/ }).click();
  await expect(buyer.getByText('Order placed')).toBeVisible();

  // Everyone now sees it sold out and can't add it.
  const other = await (await browser.newContext()).newPage();
  await signIn(other, `e2e.stock.other.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  const puff = other
    .getByRole('region', { name: 'Snacks' })
    .getByRole('listitem')
    .filter({ hasText: 'Veg puff' });
  await expect(puff).toContainText('Sold out');
  await expect(other.getByRole('button', { name: 'Add Veg puff to cart' })).toHaveCount(0);
  await expect(puffRow).toContainText('0 left'); // the manager's screen follows (live event or refresh)

  // The cashier restocks; it can be ordered again.
  const cashier = await (await browser.newContext()).newPage();
  await signIn(cashier, 'e2e.cashier@example.com', '/pos/stock');
  await cashier.getByRole('button', { name: 'Restock Veg puff' }).click();
  const restock = cashier.getByRole('dialog', { name: 'Restock Veg puff' });
  await restock.getByLabel('Units to add').fill('10');
  await restock.getByRole('button', { name: 'Add stock' }).click();
  await expect(cashier.getByText('Veg puff: +10 → 10 in stock')).toBeVisible();

  await other.reload();
  await expect(other.getByRole('button', { name: 'Add Veg puff to cart' })).toBeVisible();

  // The history shows who did what.
  await managerPage.reload();
  await managerPage.getByRole('button', { name: 'Stock history for Veg puff' }).click();
  const history = managerPage.getByRole('list', { name: 'Stock changes' });
  await expect(history).toContainText('Restocked');
  await expect(history).toContainText('Ordered');
  await expect(history).toContainText('Started counting');
});
