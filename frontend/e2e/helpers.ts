import { expect, type Page } from '@playwright/test';

/** Signs in through the developer login form (test environment only). */
export async function signIn(page: Page, email: string, returnTo = '/') {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in as developer' }).click();
  await expect(page).toHaveURL(new RegExp(`${returnTo.replace(/[/?]/g, '\\$&')}$`));
}

export async function walletBalance(page: Page): Promise<string> {
  const card = page.getByRole('region', { name: 'Available balance' });
  await expect(card).toBeVisible();
  return (await card.locator('p.font-display').innerText()).trim();
}

export async function expectLive(page: Page) {
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^Live$/ })
      .first(),
  ).toBeVisible();
}

/** The student's live pickup code, read from their order page as they'd show it at the counter. */
export async function pickupCodeOf(studentPage: Page): Promise<string> {
  const code = studentPage.locator('[aria-label^="Pickup code "]');
  await expect(code).toBeVisible();
  return ((await code.getAttribute('aria-label')) ?? '').replace(/\D/g, '');
}

/**
 * Staff hand-over: Verify pickup → type the student's code → check the matched order →
 * Confirm handover. Pass `dialogOpen` when the Verify pickup dialog is already showing.
 */
export async function verifyAndHandOver(
  staffPage: Page,
  code: string,
  { orderNumber, dialogOpen = false }: { orderNumber?: string; dialogOpen?: boolean } = {},
) {
  if (!dialogOpen) await staffPage.getByRole('button', { name: 'Verify pickup' }).first().click();
  const dialog = staffPage.getByRole('dialog', { name: 'Verify pickup' });
  await dialog.getByLabel('Student’s pickup code').fill(code);
  await dialog.getByRole('button', { name: 'Verify code' }).click();
  if (orderNumber) await expect(dialog.getByText(orderNumber, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm handover' }).click();
  await expect(dialog.getByText(/handed over at/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
}
