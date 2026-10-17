import { prisma } from '../lib/prisma.js';
import { istDay } from '../modules/orders/pickup.js';
import { makeCategory, makeItem, makeOutlet } from './fixtures.js';
import { signIn, staffApp } from './staff.js';
import { assign } from './fixtures.js';
import type { Agent } from './commerce.js';

/** Two outlets with real menu items, each with its own assigned manager. */
export async function pollWorld() {
  const outlet = await makeOutlet({ name: 'North Canteen' });
  const otherOutlet = await makeOutlet({ name: 'South Café' });
  const mains = await makeCategory(outlet.id, 'Mains');
  const otherMains = await makeCategory(otherOutlet.id, 'Mains');
  const wrap = await makeItem(outlet.id, mains.id, { name: 'Paneer Wrap', pricePaise: 9000 });
  const burger = await makeItem(outlet.id, mains.id, { name: 'Veg Burger', pricePaise: 7000 });
  const pasta = await makeItem(outlet.id, mains.id, {
    name: 'White Sauce Pasta',
    pricePaise: 11000,
  });
  const soldOut = await makeItem(outlet.id, mains.id, { name: 'Thali', isAvailable: false });
  const elsewhere = await makeItem(otherOutlet.id, otherMains.id, { name: 'Dosa' });

  const manager = await signIn('manager@example.com');
  const otherManager = await signIn('other.manager@example.com');
  const cashier = await signIn('cashier@example.com');
  await assign('manager@example.com', outlet.id, 'MANAGER');
  await assign('other.manager@example.com', otherOutlet.id, 'MANAGER');
  await assign('cashier@example.com', outlet.id, 'POS');

  return {
    outlet,
    otherOutlet,
    wrap,
    burger,
    pasta,
    soldOut,
    elsewhere,
    manager,
    otherManager,
    cashier,
  };
}

export const students = (count: number, prefix = 'voter') =>
  Promise.all(Array.from({ length: count }, (_, i) => signIn(`${prefix}${i}@example.com`)));

const json = (agent: Agent, method: 'post' | 'patch' | 'delete', url: string, body?: object) =>
  agent[method](`/api/v1${url}`)
    .set('X-Requested-With', 'CampusCart')
    .send(body ?? {});

export const staffPolls = (outletId: string) => `/staff/outlets/${outletId}/polls`;

/**
 * A voting window that has already started and ends in an hour. The special's date is
 * the IST date the window closes on, so the window never crosses that date's end.
 */
export function liveWindow(minutes = 60) {
  const now = Date.now();
  const closesAt = new Date(now + minutes * 60_000);
  return {
    day: istDay(closesAt),
    opensAt: new Date(now - 60_000).toISOString(),
    closesAt: closesAt.toISOString(),
  };
}

export function createPoll(
  manager: Agent,
  outletId: string,
  menuItemIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return json(manager, 'post', staffPolls(outletId), {
    ...liveWindow(),
    menuItemIds,
    ...overrides,
  });
}

/** Creates and opens a poll that is accepting votes right now. */
export async function openPollWith(
  manager: Agent,
  outletId: string,
  menuItemIds: string[],
  overrides: Record<string, unknown> = {},
) {
  const created = await createPoll(manager, outletId, menuItemIds, overrides);
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const poll = created.body.poll as { id: string; options: { id: string; dish: { id: string } }[] };
  await json(manager, 'post', `${staffPolls(outletId)}/${poll.id}/open`).expect(200);
  const optionFor = (menuItemId: string) => poll.options.find((o) => o.dish.id === menuItemId)!.id;
  return { pollId: poll.id, optionFor };
}

export const vote = (agent: Agent, pollId: string, optionId: string) =>
  json(agent, 'post', `/polls/${pollId}/vote`, { optionId });

export const lifecycle = (
  manager: Agent,
  outletId: string,
  pollId: string,
  action: 'open' | 'close' | 'finalize',
  body?: object,
) => json(manager, 'post', `${staffPolls(outletId)}/${pollId}/${action}`, body);

export const patchPoll = (manager: Agent, outletId: string, pollId: string, body: object) =>
  json(manager, 'patch', `${staffPolls(outletId)}/${pollId}`, body);

export const deletePoll = (manager: Agent, outletId: string, pollId: string) =>
  json(manager, 'delete', `${staffPolls(outletId)}/${pollId}`);

/** Simulates the voting window running out (the server clock passing closesAt). */
export async function expireWindow(pollId: string) {
  const now = Date.now();
  await prisma.dailyPoll.update({
    where: { id: pollId },
    data: { opensAt: new Date(now - 2 * 60 * 60_000), closesAt: new Date(now - 1000) },
  });
}

export async function castVotes(pollId: string, optionId: string, voters: Agent[]) {
  for (const voter of voters) await vote(voter, pollId, optionId).expect(200);
}

export { staffApp };
