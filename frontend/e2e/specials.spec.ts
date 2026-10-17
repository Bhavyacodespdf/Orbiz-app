import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

/*
 * Today's Special voting, end to end against the real backend and database:
 * a manager creates and opens a poll, students vote (one changes their mind),
 * the manager closes it, and the dish with the most persisted votes becomes the
 * special on the outlet page (and on the home page when the poll is for today).
 */

const IST = 'Asia/Kolkata';
const parts = (ms: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: IST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
const istLocal = (ms: number) => {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

async function seriousA11yProblems(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);
}

async function voteFor(page: Page, dish: string) {
  const panel = page.getByRole('region', { name: /^Vote for .* special$/ });
  await panel.getByRole('button', { name: `Vote for ${dish}` }).click();
  await expect(panel.getByRole('status')).toContainText(`Your vote: ${dish}.`);
}

test('students choose Today’s Special by majority vote', async ({ browser }) => {
  // A window that is open now and closes in 30 minutes; its date is the IST date it closes on.
  const now = Date.now();
  const closes = now + 30 * 60_000;
  const day = istLocal(closes).slice(0, 10);
  const today = istLocal(now).slice(0, 10);

  const managerPage = await (await browser.newContext()).newPage();
  await signIn(managerPage, 'e2e.manager@example.com', '/manage/specials');
  await expect(managerPage.getByText('No polls yet')).toBeVisible();

  await managerPage.getByRole('button', { name: 'New poll' }).click();
  const dialog = managerPage.getByRole('dialog', { name: 'New Today’s Special poll' });
  await dialog.getByLabel('Special for', { exact: true }).fill(day);
  await dialog.getByLabel('Voting opens', { exact: true }).fill(istLocal(now - 2 * 60_000));
  await dialog.getByLabel('Voting closes', { exact: true }).fill(istLocal(closes));
  await dialog.getByRole('checkbox', { name: /Masala chai/ }).check();
  await dialog.getByRole('checkbox', { name: /Filter coffee/ }).check();
  await dialog.getByRole('button', { name: 'Create draft' }).click();
  await expect(dialog).toBeHidden();

  const card = managerPage.getByRole('region', { name: /Special for/ });
  await expect(card.getByText('Draft', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Open voting' }).click();
  await managerPage
    .getByRole('dialog', { name: 'Open voting?' })
    .getByRole('button', { name: 'Open voting' })
    .click();
  await expect(card.getByText('Voting open', { exact: true })).toBeVisible();

  // Three students vote; the first changes their mind. Final tally: chai 2, coffee 1.
  const stamp = Date.now();
  const voters = [] as Page[];
  for (const n of [1, 2, 3]) {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, `e2e.voter${n}.${stamp}@example.com`, '/outlets/night-owl-cafe');
    voters.push(page);
  }
  const [first, second, third] = voters as [Page, Page, Page];
  await expect(first.getByText('Vote counts are revealed when voting closes.')).toBeVisible();
  await voteFor(first, 'Filter coffee');
  await voteFor(first, 'Masala chai');
  await voteFor(second, 'Masala chai');
  await voteFor(third, 'Filter coffee');
  expect(await seriousA11yProblems(first)).toEqual([]);

  // The manager sees the live tally from persisted votes (pushed over the socket, or the refresh).
  const chaiRow = card.getByRole('listitem').filter({ hasText: 'Masala chai' });
  await expect(chaiRow).toContainText('2 votes', { timeout: 20_000 });
  await expect(card.getByText('3 votes cast.')).toBeVisible();
  expect(await seriousA11yProblems(managerPage)).toEqual([]);

  await card.getByRole('button', { name: 'Close voting now' }).click();
  await managerPage
    .getByRole('dialog', { name: 'Close voting now?' })
    .getByRole('button', { name: 'Close voting' })
    .click();
  await expect(card.getByText('Finalized', { exact: true })).toBeVisible();
  await expect(card).toContainText('Masala chai is the special. Won with 2 of 3 votes (66.7%).');

  // Students see the result and can no longer vote.
  await third.reload();
  const banner = third.getByRole('region', { name: 'Masala chai' });
  if (day === today) {
    await expect(banner).toContainText('Won with 2 of 3 votes (66.7%)');
  }
  const results = third.getByRole('region', { name: /^Results: .* special$/ });
  await expect(results).toBeVisible();
  await expect(results.getByRole('button', { name: /Vote for/ })).toHaveCount(0);
  await expect(results.getByRole('status')).toContainText('Your vote: Filter coffee.');

  if (day === today) {
    await third.goto('/');
    await expect(
      third.getByRole('link', { name: 'Masala chai, today’s special at Night Owl Café' }),
    ).toBeVisible();
  }
});
