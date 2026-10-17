import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { signIn, staffApp } from '../../tests/staff.js';
import type { Agent } from '../../tests/commerce.js';
import {
  castVotes,
  createPoll,
  deletePoll,
  expireWindow,
  lifecycle,
  liveWindow,
  openPollWith,
  patchPoll,
  pollWorld,
  staffPolls,
  students,
  vote,
} from '../../tests/polls.js';
import { addDays, dayOf } from './polls.service.js';

let w: Awaited<ReturnType<typeof pollWorld>>;

beforeEach(async () => {
  await resetDatabase();
  w = await pollWorld();
});

const pollRow = (id: string) => prisma.dailyPoll.findUniqueOrThrow({ where: { id } });
const managerPoll = async (manager: Agent, outletId: string, pollId: string) =>
  (await manager.get(`/api/v1${staffPolls(outletId)}/${pollId}`).expect(200)).body.poll;
const special = async (slug: string, day?: string) =>
  (
    await request(staffApp)
      .get(`/api/v1/outlets/${slug}/special${day ? `?day=${day}` : ''}`)
      .expect(200)
  ).body;

/** Opens a three-dish poll and casts the given number of votes for each dish. */
async function pollWithVotes(counts: { wrap: number; burger: number; pasta: number }) {
  const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
    w.wrap.id,
    w.burger.id,
    w.pasta.id,
  ]);
  const voters = await students(counts.wrap + counts.burger + counts.pasta);
  await castVotes(pollId, optionFor(w.wrap.id), voters.slice(0, counts.wrap));
  await castVotes(
    pollId,
    optionFor(w.burger.id),
    voters.slice(counts.wrap, counts.wrap + counts.burger),
  );
  await castVotes(pollId, optionFor(w.pasta.id), voters.slice(counts.wrap + counts.burger));
  return { pollId, optionFor, voters };
}

describe('choosing the winner from persisted votes', () => {
  it('makes the dish with the most votes Today’s Special when voting closes', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 4, burger: 3, pasta: 1 });
    await expireWindow(pollId);

    // The next read settles the poll: closes it and finalizes the unambiguous result.
    const poll = await managerPoll(w.manager, w.outlet.id, pollId);
    expect(poll.status).toBe('FINALIZED');
    expect(poll.result).toMatchObject({
      outcome: 'WINNER',
      winnerOptionId: optionFor(w.wrap.id),
      totalVotes: 8,
      winnerVotes: 4,
      winnerPercentage: 50,
    });

    const row = await pollRow(pollId);
    expect(row.winnerOptionId).toBe(optionFor(w.wrap.id));
    const persisted = await prisma.dailyPollVote.count({ where: { pollId } });
    expect(row.totalVotes).toBe(persisted);

    const { special: s } = await special(w.outlet.slug, dayOf(row.day));
    expect(s).toMatchObject({
      pollId,
      outcome: 'WINNER',
      dish: { id: w.wrap.id, name: 'Paneer Wrap', pricePaise: 9000, category: { name: 'Mains' } },
      outlet: { id: w.outlet.id, name: 'North Canteen' },
      totalVotes: 8,
      winnerVotes: 4,
    });
  });

  it('counts the latest choice of a student who changed their vote', async () => {
    const { pollId, optionFor, voters } = await pollWithVotes({ wrap: 2, burger: 1, pasta: 0 });
    // Both wrap voters switch to burger: burger now leads 3–0.
    await castVotes(pollId, optionFor(w.burger.id), voters.slice(0, 2));
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);
    const row = await pollRow(pollId);
    expect(row.status).toBe('FINALIZED');
    expect(row.winnerOptionId).toBe(optionFor(w.burger.id));
    expect(row.totalVotes).toBe(3);
  });

  it('does not count votes for a dish withdrawn from the menu', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 3, burger: 2, pasta: 0 });
    await prisma.menuItem.update({ where: { id: w.wrap.id }, data: { isActive: false } });
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);
    const row = await pollRow(pollId);
    expect(row.winnerOptionId).toBe(optionFor(w.burger.id));
    expect(row.totalVotes).toBe(2);
  });

  it('produces no winner and no special when nobody voted', async () => {
    const { pollId } = await openPollWith(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]);
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);

    const row = await pollRow(pollId);
    expect(row).toMatchObject({
      status: 'FINALIZED',
      outcome: 'NO_VOTES',
      winnerOptionId: null,
      totalVotes: 0,
      winnerVotes: null,
    });
    expect((await special(w.outlet.slug, dayOf(row.day))).special).toBeNull();
    const all = await request(staffApp)
      .get(`/api/v1/specials?day=${dayOf(row.day)}`)
      .expect(200);
    expect(all.body.specials).toEqual([]);
  });

  it('the database refuses a fabricated winner for a poll nobody voted in', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    await expect(
      prisma.dailyPoll.update({
        where: { id: pollId },
        data: {
          status: 'FINALIZED',
          outcome: 'NO_VOTES',
          winnerOptionId: optionFor(w.wrap.id),
          totalVotes: 0,
          finalizedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('ties', () => {
  it('waits for the manager, accepts only a tied dish, and discloses the resolution', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 2, burger: 2, pasta: 1 });
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);

    const closed = await managerPoll(w.manager, w.outlet.id, pollId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.result).toBeNull();
    const tied = [optionFor(w.wrap.id), optionFor(w.burger.id)].sort();
    expect(closed.tiedOptionIds).toEqual(tied);
    expect((await special(w.outlet.slug, closed.day)).special).toBeNull();

    const noChoice = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize').expect(409);
    expect(noChoice.body.error.code).toBe('TIE_NEEDS_DECISION');
    expect(noChoice.body.error.details.tiedOptionIds).toEqual(tied);

    const notTied = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize', {
      tieBreakOptionId: optionFor(w.pasta.id),
    }).expect(400);
    expect(notTied.body.error.code).toBe('INVALID_POLL');

    const done = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize', {
      tieBreakOptionId: optionFor(w.burger.id),
    }).expect(200);
    expect(done.body.poll.result).toMatchObject({
      outcome: 'TIE_RESOLVED_BY_MANAGER',
      winnerOptionId: optionFor(w.burger.id),
      totalVotes: 5,
      winnerVotes: 2,
    });
    const { special: s } = await special(w.outlet.slug, closed.day);
    expect(s).toMatchObject({ outcome: 'TIE_RESOLVED_BY_MANAGER', dish: { name: 'Veg Burger' } });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'POLL_FINALIZED', entityId: pollId },
    });
    expect(audit.actorType).toBe('USER');
    expect(audit.metadata).toMatchObject({
      outcome: 'TIE_RESOLVED_BY_MANAGER',
      tiedOptionIds: tied,
    });
  });

  it('refuses a tie-break choice when there is no tie', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 2, burger: 1, pasta: 0 });
    await expireWindow(pollId);
    const res = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize', {
      tieBreakOptionId: optionFor(w.burger.id),
    }).expect(409);
    expect(res.body.error.code).toBe('NOT_A_TIE');
    expect((await pollRow(pollId)).winnerOptionId).toBeNull();

    await lifecycle(w.manager, w.outlet.id, pollId, 'finalize').expect(200);
    expect((await pollRow(pollId)).winnerOptionId).toBe(optionFor(w.wrap.id));
  });

  it('never accepts a winner from the client', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 1, burger: 2, pasta: 0 });
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);
    const res = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize', {
      winnerOptionId: optionFor(w.wrap.id),
    }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await pollRow(pollId)).winnerOptionId).toBe(optionFor(w.burger.id));
  });
});

describe('finalization is idempotent', () => {
  it('returns the same stored result however many times it runs, even concurrently', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 1, burger: 3, pasta: 1 });
    await expireWindow(pollId);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => lifecycle(w.manager, w.outlet.id, pollId, 'finalize')),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    for (const r of results) expect(r.body.poll.result.winnerOptionId).toBe(optionFor(w.burger.id));

    const again = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize').expect(200);
    expect(again.body.poll.result).toEqual(results[0]!.body.poll.result);
    expect(
      await prisma.auditLog.count({ where: { action: 'POLL_FINALIZED', entityId: pollId } }),
    ).toBe(1);
  });

  it('cannot be redirected to another dish after the fact', async () => {
    const { pollId, optionFor } = await pollWithVotes({ wrap: 2, burger: 2, pasta: 0 });
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);
    await lifecycle(w.manager, w.outlet.id, pollId, 'finalize', {
      tieBreakOptionId: optionFor(w.wrap.id),
    }).expect(200);
    const res = await lifecycle(w.manager, w.outlet.id, pollId, 'finalize', {
      tieBreakOptionId: optionFor(w.burger.id),
    }).expect(409);
    expect(res.body.error.code).toBe('POLL_ALREADY_FINALIZED');
    expect((await pollRow(pollId)).winnerOptionId).toBe(optionFor(w.wrap.id));
  });
});

describe('lifecycle rules', () => {
  it('walks DRAFT → OPEN → CLOSED → FINALIZED and audits each step', async () => {
    const created = await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]).expect(201);
    const id = created.body.poll.id;
    expect(created.body.poll.status).toBe('DRAFT');

    await lifecycle(w.manager, w.outlet.id, id, 'finalize').expect(409);
    await lifecycle(w.manager, w.outlet.id, id, 'close').expect(409);
    await lifecycle(w.manager, w.outlet.id, id, 'open').expect(200);
    await lifecycle(w.manager, w.outlet.id, id, 'open').expect(409);

    const stillOpen = await lifecycle(w.manager, w.outlet.id, id, 'finalize').expect(409);
    expect(stillOpen.body.error.code).toBe('POLL_NOT_CLOSED');

    await vote(await signIn('s1@example.com'), id, created.body.poll.options[0].id).expect(200);
    await lifecycle(w.manager, w.outlet.id, id, 'close').expect(200);
    await lifecycle(w.manager, w.outlet.id, id, 'close').expect(200); // idempotent
    expect((await pollRow(id)).status).toBe('FINALIZED');

    const actions = (
      await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })
    ).map((a) => a.action);
    expect(actions).toEqual(['POLL_CREATED', 'POLL_OPENED', 'POLL_CLOSED', 'POLL_FINALIZED']);
  });

  it('allows editing and deleting drafts only', async () => {
    const created = await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]).expect(201);
    const id = created.body.poll.id;
    const edited = await patchPoll(w.manager, w.outlet.id, id, {
      menuItemIds: [w.pasta.id, w.burger.id, w.wrap.id],
      showLiveResults: true,
    }).expect(200);
    expect(edited.body.poll.options.map((o: { dish: { name: string } }) => o.dish.name)).toEqual([
      'White Sauce Pasta',
      'Veg Burger',
      'Paneer Wrap',
    ]);
    expect(edited.body.poll.showLiveResults).toBe(true);

    await lifecycle(w.manager, w.outlet.id, id, 'open').expect(200);
    const locked = await patchPoll(w.manager, w.outlet.id, id, { showLiveResults: false }).expect(
      409,
    );
    expect(locked.body.error.code).toBe('POLL_NOT_EDITABLE');
    await deletePoll(w.manager, w.outlet.id, id).expect(409);

    const later = addDays(liveWindow().day, 1);
    const draft = await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id], {
      day: later,
      opensAt: `${later}T10:00:00+05:30`,
      closesAt: `${later}T12:00:00+05:30`,
    }).expect(201);
    await deletePoll(w.manager, w.outlet.id, draft.body.poll.id).expect(204);
    expect(await prisma.dailyPoll.count({ where: { id: draft.body.poll.id } })).toBe(0);
  });

  it('allows one poll per outlet per date', async () => {
    await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]).expect(201);
    const dup = await createPoll(w.manager, w.outlet.id, [w.pasta.id, w.burger.id]).expect(409);
    expect(dup.body.error.code).toBe('POLL_EXISTS');
  });

  it('validates the voting window on the server', async () => {
    const base = liveWindow();
    const cases: Record<string, unknown>[] = [
      {
        closesAt: new Date(Date.now() - 60_000).toISOString(),
        opensAt: new Date(Date.now() - 120 * 60_000).toISOString(),
      },
      { closesAt: base.opensAt, opensAt: base.closesAt },
      { day: addDays(base.day, -1) },
      { day: addDays(base.day, 30) },
      { closesAt: new Date(Date.parse(base.opensAt) + 60_000).toISOString() },
    ];
    for (const overrides of cases) {
      const res = await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id], overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(400);
    }
    const one = await createPoll(w.manager, w.outlet.id, [w.wrap.id]).expect(400);
    expect(one.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.dailyPoll.count()).toBe(0);
  });
});

describe('authorization and isolation', () => {
  it('keeps managers out of polls of outlets they are not assigned to', async () => {
    const { pollId } = await openPollWith(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]);

    // Another outlet's manager, using this outlet's URL: not assigned → 403.
    for (const action of ['close', 'finalize'] as const) {
      await lifecycle(w.otherManager, w.outlet.id, pollId, action).expect(403);
    }
    await createPoll(w.otherManager, w.outlet.id, [w.wrap.id, w.burger.id]).expect(403);
    await w.otherManager.get(`/api/v1${staffPolls(w.outlet.id)}`).expect(403);

    // …or using their own outlet's URL with this poll's ID: not found.
    await lifecycle(w.otherManager, w.otherOutlet.id, pollId, 'close').expect(404);
    await w.otherManager.get(`/api/v1${staffPolls(w.otherOutlet.id)}/${pollId}`).expect(404);

    // POS staff and students cannot manage polls at all.
    await lifecycle(w.cashier, w.outlet.id, pollId, 'close').expect(403);
    const student = await signIn('student@example.com');
    await lifecycle(student, w.outlet.id, pollId, 'close').expect(403);

    expect((await pollRow(pollId)).status).toBe('OPEN');
  });

  it('keeps Today’s Special separate per outlet and per date', async () => {
    const mine = await pollWithVotes({ wrap: 2, burger: 0, pasta: 0 });
    await lifecycle(w.manager, w.outlet.id, mine.pollId, 'close').expect(200);
    const day = dayOf((await pollRow(mine.pollId)).day);

    expect((await special(w.outlet.slug, day)).special.dish.name).toBe('Paneer Wrap');
    expect((await special(w.otherOutlet.slug, day)).special).toBeNull();
    expect((await special(w.outlet.slug, addDays(day, 1))).special).toBeNull();

    const all = await request(staffApp).get(`/api/v1/specials?day=${day}`).expect(200);
    expect(all.body.specials).toHaveLength(1);
    expect(all.body.specials[0].outlet.id).toBe(w.outlet.id);
    expect(
      (await request(staffApp).get(`/api/v1/specials?day=${addDays(day, -1)}`)).body.specials,
    ).toEqual([]);
  });

  it('lists past polls and their results for the outlet’s manager only', async () => {
    const { pollId } = await pollWithVotes({ wrap: 1, burger: 0, pasta: 0 });
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);
    await openPollWith(w.otherManager, w.otherOutlet.id, [
      w.elsewhere.id,
      (
        await prisma.menuItem.create({
          data: {
            outletId: w.otherOutlet.id,
            categoryId: w.elsewhere.categoryId,
            name: 'Vada',
            pricePaise: 3000,
          },
        })
      ).id,
    ]);

    const res = await w.manager.get(`/api/v1${staffPolls(w.outlet.id)}`).expect(200);
    expect(res.body.polls).toHaveLength(1);
    expect(res.body.polls[0]).toMatchObject({
      id: pollId,
      status: 'FINALIZED',
      result: { outcome: 'WINNER' },
    });
  });
});
