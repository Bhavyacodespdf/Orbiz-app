import { expect, test } from '@playwright/test';
import { expectLive, signIn, walletBalance, pickupCodeOf, verifyAndHandOver } from './helpers';

/*
 * The end-to-end journey from the project brief (steps 1–14), across a
 * student, a cashier and a manager in separate browser sessions.
 * Uses the developer login and the MOCK payment simulator only.
 */

test.describe.serial('student ordering journey', () => {
  const student = `e2e.student.${Date.now()}@example.com`;
  let orderUrl = '';

  test('1–6: sign in, browse, add to cart, recharge (failure and success) with honest balances', async ({
    page,
  }) => {
    // 1. Sign in
    await signIn(page, student);

    // 2. Browse persisted outlets and menu
    await page.getByRole('link', { name: /Night Owl Café/ }).click();
    await expect(page.getByRole('heading', { name: 'Night Owl Café', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Hot drinks' })).toContainText('Masala chai');
    await expect(page.getByRole('region', { name: 'Snacks' })).toContainText('Sold out'); // sample sold-out item

    // 3. Add to cart (2 × ₹20 = ₹40)
    await page.getByRole('button', { name: 'Add Masala chai to cart' }).click();
    await page.getByRole('button', { name: 'One more Masala chai' }).click();
    await expect(page.getByRole('link', { name: /2 items · ₹40/ })).toBeVisible();

    // 4–6. Wallet starts at ₹0; a failed and a cancelled recharge change nothing; a success credits once.
    await page.goto('/wallet');
    await expect(page.getByText(/Test mode — simulated funds/)).toBeVisible();
    expect(await walletBalance(page)).toBe('₹0');

    for (const outcome of ['Simulate failed payment', 'Cancel payment']) {
      await page.getByRole('button', { name: '₹99', exact: true }).click();
      await page.getByRole('button', { name: 'Add ₹99' }).click();
      const dialog = page.getByRole('dialog', { name: 'Test payment simulator' });
      await expect(dialog).toContainText('No real money moves');
      await dialog.getByRole('button', { name: outcome }).click();
      await expect(dialog).toBeHidden();
      expect(await walletBalance(page)).toBe('₹0');
    }
    // Failed and cancelled payments earn no points either.
    await expect(page.getByRole('region', { name: 'Loyalty points' })).toContainText('0 points');

    await page.getByRole('button', { name: '₹500 +10 points', exact: true }).click();
    await page.getByRole('button', { name: 'Add ₹500' }).click();
    await page
      .getByRole('dialog', { name: 'Test payment simulator' })
      .getByRole('button', { name: 'Simulate successful payment' })
      .click();
    await expect.poll(() => walletBalance(page)).toBe('₹500');
    await expect(page.getByRole('region', { name: 'Loyalty points' })).toContainText('10 points');

    const history = page.getByRole('list', { name: 'Wallet transactions' });
    await expect(history.getByRole('listitem')).toHaveCount(3);
    await expect(history).toContainText('Failed');
    await expect(history).toContainText('Cancelled');
    await expect(history).toContainText('+₹500');
  });

  test('7–8: pay with the wallet; order and debit persist consistently', async ({ page }) => {
    await signIn(page, student, '/checkout');
    await page.getByRole('button', { name: 'Pay from wallet · ₹40' }).click();
    await expect(page.getByText('Order placed')).toBeVisible();
    await expect(page.getByText('Paid from wallet (simulated test funds)')).toBeVisible();
    orderUrl = page.url();

    await page.goto('/wallet');
    expect(await walletBalance(page)).toBe('₹460');
    await expect(page.getByRole('list', { name: 'Wallet transactions' })).toContainText('−₹40');
  });

  test('9–11: staff process the order; the student sees live updates; refresh restores state', async ({
    browser,
  }) => {
    const studentCtx = await browser.newContext();
    const cashierCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    const cashierPage = await cashierCtx.newPage();

    await signIn(studentPage, student, new URL(orderUrl).pathname);
    await expectLive(studentPage);
    await expect(studentPage.getByText('Placed — waiting for the outlet to accept')).toBeVisible();

    await signIn(cashierPage, 'e2e.cashier@example.com', '/pos');
    await expectLive(cashierPage);
    const ticket = cashierPage.getByRole('article').first();
    await expect(ticket).toContainText('Paid · wallet');

    for (const [button, studentSees] of [
      ['Accept', 'Accepted'],
      ['Start preparing', 'Being prepared'],
      ['Mark ready', 'Ready for pickup'],
    ] as const) {
      await ticket.getByRole('button', { name: button }).click();
      // 10. The student's page updates by itself over the live connection.
      await expect(studentPage.getByText(studentSees, { exact: true }).first()).toBeVisible();
    }
    // Handover needs the student's pickup code: staff verify it, then confirm.
    await verifyAndHandOver(cashierPage, await pickupCodeOf(studentPage));
    await expect(studentPage.getByText('Collected', { exact: true }).first()).toBeVisible();
    await expect(studentPage.getByRole('region', { name: 'Order collected' })).toBeVisible();

    // 11. A full reload restores the same persisted state.
    await studentPage.reload();
    await expect(studentPage.getByText('Collected', { exact: true }).first()).toBeVisible();
    await studentPage.goto('/wallet');
    expect(await walletBalance(studentPage)).toBe('₹460');

    await studentCtx.close();
    await cashierCtx.close();
  });

  test('12–13: no access to staff areas or to other people’s orders', async ({ page }) => {
    await signIn(page, student);
    for (const path of ['/manage', '/pos', '/admin']) {
      await page.goto(path);
      await expect(page.getByText('You don’t have access to this page')).toBeVisible();
    }
    // The API refuses too — the screen is not the security boundary.
    const status = await page.evaluate(() => fetch('/api/v1/admin/users').then((r) => r.status));
    expect(status).toBe(403);

    // Another student cannot open this student's order.
    await page.goto('/');
    await page.evaluate(() =>
      fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'CampusCart' },
      }),
    );
    await signIn(page, `e2e.other.${Date.now()}@example.com`);
    await page.goto(new URL(orderUrl).pathname);
    await expect(page.getByText('Order not found')).toBeVisible();
  });

  test('14: pay-at-counter order is unpaid until the cashier records the money', async ({
    browser,
  }) => {
    const studentCtx = await browser.newContext();
    const cashierCtx = await browser.newContext();
    const studentPage = await studentCtx.newPage();
    const cashierPage = await cashierCtx.newPage();

    await signIn(studentPage, student, '/outlets/night-owl-cafe');
    await studentPage.getByRole('button', { name: 'Add Filter coffee to cart' }).click();
    await studentPage.goto('/checkout');
    await studentPage.getByRole('radio', { name: /Pay at the counter/ }).check();
    await studentPage.getByRole('button', { name: 'Place order · ₹30' }).click();
    await expect(
      studentPage.getByText(/Pay ₹30 at the counter when you collect — not paid yet/),
    ).toBeVisible();
    const code = (await studentPage.locator('p.font-display').first().innerText()).trim();

    await signIn(cashierPage, 'e2e.cashier@example.com', '/pos');
    const ticket = cashierPage.getByRole('article', { name: `Order ${code}` });
    await expect(ticket).toContainText('Collect ₹30');
    for (const button of ['Accept', 'Start preparing', 'Mark ready'])
      await ticket.getByRole('button', { name: button }).click();

    await ticket.getByRole('button', { name: 'Take ₹30' }).click();
    const dialog = cashierPage.getByRole('dialog', { name: `Order ${code}` });
    await expect(dialog.getByRole('button', { name: 'Hand over' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Record counter payment' }).click();
    await dialog.getByRole('button', { name: 'Confirm ₹30 received' }).click();
    await expect(dialog.getByText('Paid · counter')).toBeVisible();
    await dialog.getByRole('button', { name: 'Verify pickup' }).click();
    await verifyAndHandOver(cashierPage, await pickupCodeOf(studentPage), {
      orderNumber: code,
      dialogOpen: true,
    });

    await expect(studentPage.getByText('Paid at the counter')).toBeVisible();
    await expect(studentPage.getByText('Collected', { exact: true }).first()).toBeVisible();
    // The wallet was never touched by the counter order.
    await studentPage.goto('/wallet');
    expect(await walletBalance(studentPage)).toBe('₹460');

    await studentCtx.close();
    await cashierCtx.close();
  });
});

test('manager rejects a wallet order and the student is refunded automatically', async ({
  browser,
}) => {
  const shopper = `e2e.refund.${Date.now()}@example.com`;
  const studentCtx = await browser.newContext();
  const managerCtx = await browser.newContext();
  const studentPage = await studentCtx.newPage();
  const managerPage = await managerCtx.newPage();

  await signIn(studentPage, shopper, '/wallet');
  await studentPage.getByRole('button', { name: '₹99', exact: true }).click();
  await studentPage.getByRole('button', { name: 'Add ₹99' }).click();
  await studentPage
    .getByRole('dialog', { name: 'Test payment simulator' })
    .getByRole('button', { name: 'Simulate successful payment' })
    .click();
  await expect.poll(() => walletBalance(studentPage)).toBe('₹99');

  await studentPage.goto('/outlets/night-owl-cafe');
  await studentPage.getByRole('button', { name: 'Add Hot chocolate to cart' }).click();
  await studentPage.goto('/checkout');
  await studentPage.getByRole('button', { name: 'Pay from wallet · ₹60' }).click();
  await expect(studentPage.getByText('Order placed')).toBeVisible();
  const code = (await studentPage.locator('p.font-display').first().innerText()).trim();

  await signIn(managerPage, 'e2e.manager@example.com', '/manage');
  await managerPage.getByRole('button', { name: new RegExp(`^Open order ${code}`) }).click();
  const dialog = managerPage.getByRole('dialog', { name: `Order ${code}` });
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await dialog.getByLabel(/Reason for the student/).fill('Out of milk');
  await dialog.getByRole('button', { name: 'Confirm: Reject' }).click();

  await expect(studentPage.getByText(/couldn’t take this order/)).toContainText('Out of milk');
  await expect(
    studentPage.getByText('₹60 refunded to your wallet (simulated funds)'),
  ).toBeVisible();
  await studentPage.goto('/wallet');
  expect(await walletBalance(studentPage)).toBe('₹99');
  await expect(studentPage.getByRole('list', { name: 'Wallet transactions' })).toContainText(
    'Refund',
  );

  await studentCtx.close();
  await managerCtx.close();
});
