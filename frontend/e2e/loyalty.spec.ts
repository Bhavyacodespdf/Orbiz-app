import { expect, test } from '@playwright/test';
import { signIn, walletBalance } from './helpers';

/*
 * Wallet recharge minimum and loyalty points, end to end on the real backend and the
 * isolated e2e database. All money is simulated test funds (mock payment simulator).
 */

test('recharge bonus, ₹99 minimum, redeeming points at checkout and getting them back', async ({
  page,
}) => {
  const student = `e2e.loyalty.${Date.now()}@example.com`;
  await signIn(page, student, '/wallet');
  const points = page.getByRole('region', { name: 'Loyalty points' });
  await expect(points).toContainText('0 points');

  // The ₹99 minimum is enforced by the server, not only by the form.
  const refused = await page.request.post('/api/v1/wallet/recharges', {
    headers: { 'X-Requested-With': 'CampusCart', 'Idempotency-Key': `e2e-${Date.now()}` },
    data: { amountPaise: 9_800 },
  });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error.code).toBe('AMOUNT_OUT_OF_RANGE');

  // A non-slab amount previews no bonus; an exact slab previews its points.
  const amount = page.getByLabel('Amount', { exact: true });
  await amount.fill('1400');
  await expect(page.getByText(/No bonus points for this amount/)).toBeVisible();
  await page.getByRole('button', { name: '₹1,000 +25 points', exact: true }).click();
  await expect(
    page.getByText('You’ll earn 25 points (worth ₹25) once this recharge succeeds.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Add ₹1,000' }).click();
  const simulator = page.getByRole('dialog', { name: 'Test payment simulator' });
  await expect(simulator).toContainText('25 loyalty points');
  await simulator.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page.getByText('You earned 25 points (test mode).')).toBeVisible();
  await expect.poll(() => walletBalance(page)).toBe('₹1,000');
  await expect(points).toContainText('25 points');
  await expect(page.getByRole('list', { name: 'Points activity' })).toContainText('+25 points');

  // Spend 20 points on a ₹40 order: the server charges ₹20 and takes exactly 20 points.
  await page.goto('/outlets/night-owl-cafe');
  await page.getByRole('button', { name: 'Add Masala chai to cart' }).click();
  await page.getByRole('button', { name: 'One more Masala chai' }).click();
  await expect(page.getByRole('link', { name: /2 items · ₹40/ })).toBeVisible();
  await page.goto('/checkout');
  await expect(page.getByText(/You can use up to 25 points on this order/)).toBeVisible();
  await page.getByLabel('Points to use').fill('20');
  await expect(page.getByText('Loyalty points (20 points)')).toBeVisible();
  await page.getByRole('button', { name: 'Pay from wallet · ₹20' }).click();

  await expect(page.getByText('Order placed')).toBeVisible();
  await expect(page.getByText('Loyalty points (20 points)')).toBeVisible();
  await expect(page.getByText('Total paid')).toBeVisible();
  const orderUrl = page.url();

  await page.goto('/wallet');
  expect(await walletBalance(page)).toBe('₹980');
  await expect(points).toContainText('5 points');

  // Cancelling returns both the money and the points, once.
  await page.goto(orderUrl);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const confirm = page.getByRole('dialog', { name: 'Cancel this order?' });
  await expect(confirm).toContainText('The 20 points used will be returned too.');
  await confirm.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);

  await page.goto('/wallet');
  await expect.poll(() => walletBalance(page)).toBe('₹1,000');
  await expect(points).toContainText('25 points');
  const activity = page.getByRole('list', { name: 'Points activity' });
  await expect(activity.getByRole('listitem')).toHaveCount(3);
  await expect(activity).toContainText('Returned (order cancelled)');
  await expect(activity).toContainText('Used at checkout');
});
