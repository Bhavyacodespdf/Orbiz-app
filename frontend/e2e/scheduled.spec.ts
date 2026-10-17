import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Scheduled orders end to end: the manager sets pickup hours, a student schedules an
 * order for a slot and sees the ₹10 fee before paying, and staff see it as scheduled.
 */

test('a student schedules an order for later and pays the ₹10 fee once', async ({ browser }) => {
  const managerPage = await (await browser.newContext()).newPage();
  await signIn(managerPage, 'e2e.manager@example.com', '/manage/outlet');
  const panel = managerPage.getByRole('region', { name: 'Scheduled orders' });
  for (const day of [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ]) {
    await panel.getByRole('checkbox', { name: day }).check();
    await panel.getByLabel(`${day} opens`).fill('00:00');
    await panel.getByLabel(`${day} closes`).fill('00:00'); // until midnight: all day
  }
  await panel.getByRole('button', { name: 'Save pickup hours' }).click();
  await expect(managerPage.getByText('Pickup hours saved')).toBeVisible();

  const student = await (await browser.newContext()).newPage();
  await signIn(student, `e2e.scheduled.${Date.now()}@example.com`, '/outlets/night-owl-cafe');
  await student.getByRole('button', { name: 'Add Masala chai to cart' }).click();
  await student.getByRole('button', { name: 'One more Masala chai' }).click();
  await expect(student.getByRole('link', { name: /2 items · ₹40/ })).toBeVisible();
  await student.goto('/checkout');

  await student.getByText('Schedule for later', { exact: true }).click();
  const time = student.getByLabel('Pickup time', { exact: true });
  await expect(time.locator('option').nth(1)).toBeAttached();
  const chosen = await time.locator('option').nth(1).getAttribute('value');
  await time.selectOption(chosen!);
  await expect(student.getByText(/^Pickup: /)).toBeVisible();
  await expect(student.getByText('Scheduled-order fee')).toBeVisible();
  await student.getByRole('radio', { name: /Pay at the counter/ }).check();
  await student.getByRole('button', { name: 'Schedule · Place order · ₹50' }).click();

  await expect(student.getByText('Order scheduled')).toBeVisible();
  await expect(student.getByText(/Scheduled pickup:/)).toBeVisible();
  await expect(student.getByText('Scheduled-order fee')).toBeVisible();
  await expect(student.getByText('Total paid')).toBeVisible();
  const code = (await student.locator('p.font-display').first().innerText()).trim();

  // Staff see it as scheduled, and can filter for it.
  await managerPage.goto('/manage');
  await managerPage.getByRole('button', { name: 'Scheduled', exact: true }).click();
  const card = managerPage.getByRole('article', { name: `Order ${code}` });
  await expect(card).toContainText('Scheduled ·');
  await expect(card).toContainText('₹50');
  await managerPage.getByRole('button', { name: 'Order now', exact: true }).click();
  await expect(managerPage.getByRole('article', { name: `Order ${code}` })).toHaveCount(0);
});
