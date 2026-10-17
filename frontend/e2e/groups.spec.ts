import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Group tray end to end on the real backend: a host creates a group, a friend joins with the
 * code, both add food, the host checks out, each pays their own share from their own wallet,
 * and the group's single order is placed.
 */

async function fund(page: Page, amountPaise: number) {
  const headers = { 'X-Requested-With': 'CampusCart' };
  const created = await page.request.post('/api/v1/wallet/recharges', {
    headers: {
      ...headers,
      'Idempotency-Key': `e2e-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    },
    data: { amountPaise },
  });
  expect(created.status()).toBe(201);
  const { recharge } = await created.json();
  const done = await page.request.post(`/api/v1/payments/mock/${recharge.id}/outcome`, {
    headers,
    data: { outcome: 'SUCCESS' },
  });
  expect(done.status()).toBe(200);
}

test('a group orders together and each member pays their own share', async ({ browser }) => {
  const stamp = Date.now();
  const host = await (await browser.newContext()).newPage();
  await signIn(host, `e2e.group.host.${stamp}@example.com`, '/groups');
  await expect(host.getByRole('heading', { name: /Group repast & splits/i })).toBeVisible();

  await host.getByRole('button', { name: 'New group' }).click();
  const create = host.getByRole('dialog', { name: 'Start a group tray' });
  await create.getByLabel('Group name').fill('E2E lunch');
  await create.getByLabel('Outlet').selectOption({ label: 'Night Owl Café' });
  await create.getByRole('button', { name: 'Create group' }).click();
  await expect(host).toHaveURL(/\/groups\/tray\//);
  const code = (await host.getByText(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/).innerText()).trim();

  const friend = await (await browser.newContext()).newPage();
  await signIn(friend, `e2e.group.friend.${stamp}@example.com`, '/groups');
  await friend.getByRole('button', { name: 'Join code' }).click();
  const join = friend.getByRole('dialog', { name: 'Join a group' });
  await join.getByLabel('Join code').fill(code.toLowerCase());
  await join.getByRole('button', { name: 'Join group' }).click();
  await expect(friend).toHaveURL(/\/groups\/tray\//);

  // Each adds their own food.
  await host.reload();
  await host.getByRole('button', { name: 'One more Masala chai' }).click();
  await expect(host.getByLabel('1 Masala chai in your share')).toBeVisible();
  await friend.getByRole('button', { name: 'One more Masala chai' }).click();
  await friend.getByRole('button', { name: 'One more Masala chai' }).click();
  await expect(friend.getByLabel('2 Masala chai in your share')).toBeVisible();

  // The host locks the tray: by dish, ₹20 and ₹40.
  await host.reload();
  await host.getByRole('button', { name: /Group checkout · ₹60/ }).click();
  const confirm = host.getByRole('dialog', { name: /Lock the tray/ });
  await expect(confirm).toContainText('₹20');
  await expect(confirm).toContainText('₹40');
  await confirm.getByRole('button', { name: 'Confirm ₹60' }).click();
  await expect(host.getByRole('heading', { name: 'Pay your share' })).toBeVisible();

  await fund(host, 10_000);
  await fund(friend, 10_000);
  await host.getByRole('button', { name: 'Pay ₹20 from wallet' }).click();
  await expect(host.getByText(/1 person hasn’t paid yet/)).toBeVisible();

  await friend.reload();
  await friend.getByRole('button', { name: 'Pay ₹40 from wallet' }).click();
  await expect(friend.getByText(/Order placed — pickup code/)).toBeVisible();

  // The wallet shows the share payment.
  await friend.goto('/wallet');
  await expect(friend.getByText('Group share').first()).toBeVisible();

  // The host cancels the order before the kitchen accepts it: every member is refunded their
  // own share (and the outlet's board is left as it was).
  await host.reload();
  await host.getByRole('link', { name: 'Track the order' }).click();
  await host.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = host.getByRole('dialog', { name: 'Cancel this order?' });
  await expect(dialog).toContainText('Every member’s share will be refunded');
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await expect(host.getByText('Every member’s share was refunded to their wallet')).toBeVisible();
  await friend.reload();
  await expect(friend.getByText(/Refund of your group share/).first()).toBeVisible();
});
