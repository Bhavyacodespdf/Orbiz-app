import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { signIn, staffApp } from '../../tests/staff.js';
import type { Agent } from '../../tests/commerce.js';
import {
  createPoll,
  expireWindow,
  lifecycle,
  openPollWith,
  pollWorld,
  students,
  vote,
} from '../../tests/polls.js';

let w: Awaited<ReturnType<typeof pollWorld>>;
let student: Agent;

beforeEach(async () => {
  await resetDatabase();
  w = await pollWorld();
  student = await signIn('student@example.com');
});

const currentPoll = async (agent: Agent, slug = w.outlet.slug) =>
  (await agent.get(`/api/v1/outlets/${slug}/poll`).expect(200)).body.poll;

const votesIn = (pollId: string) => prisma.dailyPollVote.findMany({ where: { pollId } });

describe('casting a vote', () => {
  it('records a valid vote and shows it as the student’s choice', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);

    const res = await vote(student, pollId, optionFor(w.wrap.id)).expect(200);
    expect(res.body.poll.myOptionId).toBe(optionFor(w.wrap.id));
    expect(res.body.poll.phase).toBe('VOTING');

    const rows = await votesIn(pollId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.optionId).toBe(optionFor(w.wrap.id));
    expect((await currentPoll(student)).myOptionId).toBe(optionFor(w.wrap.id));
  });

  it('collapses repeated and concurrent submissions into one vote', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => vote(student, pollId, optionFor(w.burger.id))),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await votesIn(pollId)).toHaveLength(1);
  });

  it('lets a student change their vote while voting is open; only the latest counts', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    await vote(student, pollId, optionFor(w.wrap.id)).expect(200);
    const res = await vote(student, pollId, optionFor(w.burger.id)).expect(200);
    expect(res.body.poll.myOptionId).toBe(optionFor(w.burger.id));

    const rows = await votesIn(pollId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.optionId).toBe(optionFor(w.burger.id));
  });

  it('refuses votes and vote changes after the manager closes the poll', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    await vote(student, pollId, optionFor(w.wrap.id)).expect(200);
    await lifecycle(w.manager, w.outlet.id, pollId, 'close').expect(200);

    const res = await vote(student, pollId, optionFor(w.burger.id)).expect(409);
    expect(res.body.error.code).toBe('POLL_CLOSED');
    const rows = await votesIn(pollId);
    expect(rows.map((r) => r.optionId)).toEqual([optionFor(w.wrap.id)]);
  });

  it('refuses votes once the closing time has passed, even before anything closed it', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    await expireWindow(pollId);
    const res = await vote(student, pollId, optionFor(w.wrap.id)).expect(409);
    expect(res.body.error.code).toBe('POLL_CLOSED');
    expect(await votesIn(pollId)).toHaveLength(0);
  });

  it('refuses votes before the window opens', async () => {
    const start = new Date(Date.now() + 10 * 60_000);
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    await prisma.dailyPoll.update({ where: { id: pollId }, data: { opensAt: start } });
    const res = await vote(student, pollId, optionFor(w.wrap.id)).expect(409);
    expect(res.body.error.code).toBe('POLL_NOT_OPEN');
    expect((await currentPoll(student)).phase).toBe('UPCOMING');
  });

  it('requires sign-in to view or vote', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    const anonymous = request(staffApp);
    await anonymous.get(`/api/v1/outlets/${w.outlet.slug}/poll`).expect(401);
    const res = await anonymous
      .post(`/api/v1/polls/${pollId}/vote`)
      .set('X-Requested-With', 'CampusCart')
      .send({ optionId: optionFor(w.wrap.id) })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(await votesIn(pollId)).toHaveLength(0);
  });

  it('ignores any user identity in the body: the vote belongs to the session', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    const victim = await prisma.user.findUniqueOrThrow({ where: { email: 'cashier@example.com' } });
    await student
      .post(`/api/v1/polls/${pollId}/vote`)
      .set('X-Requested-With', 'CampusCart')
      .send({ optionId: optionFor(w.wrap.id), userId: victim.id })
      .expect(400);
    expect(await votesIn(pollId)).toHaveLength(0);
  });
});

describe('what students can vote for', () => {
  it('refuses an option from another poll', async () => {
    const mine = await openPollWith(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]);
    const theirs = await openPollWith(w.otherManager, w.otherOutlet.id, [
      w.elsewhere.id,
      (
        await prisma.menuItem.create({
          data: {
            outletId: w.otherOutlet.id,
            categoryId: w.elsewhere.categoryId,
            name: 'Idli',
            pricePaise: 4000,
          },
        })
      ).id,
    ]);
    const res = await vote(student, mine.pollId, theirs.optionFor(w.elsewhere.id)).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await votesIn(mine.pollId)).toHaveLength(0);
  });

  it('refuses a dish that became unavailable after the poll opened', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    await prisma.menuItem.update({ where: { id: w.wrap.id }, data: { isAvailable: false } });
    const res = await vote(student, pollId, optionFor(w.wrap.id)).expect(409);
    expect(res.body.error.code).toBe('OPTION_NOT_ELIGIBLE');
    const poll = await currentPoll(student);
    expect(poll.options.find((o: { id: string }) => o.id === optionFor(w.wrap.id)).votable).toBe(
      false,
    );
  });

  it('never lets a poll offer unavailable dishes or another outlet’s dishes', async () => {
    for (const bad of [w.soldOut.id, w.elsewhere.id]) {
      const res = await createPoll(w.manager, w.outlet.id, [w.wrap.id, bad]).expect(400);
      expect(res.body.error.code).toBe('OPTION_NOT_ELIGIBLE');
      expect(res.body.error.details.invalidMenuItemIds).toEqual([bad]);
    }
    expect(await prisma.dailyPoll.count()).toBe(0);
  });

  it('the database itself rejects an option whose dish belongs to another outlet', async () => {
    const created = await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]).expect(201);
    await expect(
      prisma.dailyPollOption.create({
        data: {
          pollId: created.body.poll.id,
          outletId: w.outlet.id,
          menuItemId: w.elsewhere.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('hides draft polls from students', async () => {
    const created = await createPoll(w.manager, w.outlet.id, [w.wrap.id, w.burger.id]).expect(201);
    expect(await currentPoll(student)).toBeNull();
    const optionId = created.body.poll.options[0].id;
    await vote(student, created.body.poll.id, optionId).expect(404);
  });
});

describe('result visibility', () => {
  it('hides counts from students while voting, unless live results are on', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    const res = await vote(student, pollId, optionFor(w.wrap.id)).expect(200);
    expect(res.body.poll.resultsVisible).toBe(false);
    expect(res.body.poll.votesCast).toBeNull();
    expect(res.body.poll.options.every((o: { votes: unknown }) => o.votes === null)).toBe(true);

    await prisma.dailyPoll.update({ where: { id: pollId }, data: { showLiveResults: true } });
    const live = await currentPoll(student);
    expect(live.votesCast).toBe(1);
    expect(live.options.find((o: { id: string }) => o.id === optionFor(w.wrap.id))).toMatchObject({
      votes: 1,
      percentage: 100,
    });
  });

  it('never exposes who voted for what', async () => {
    const { pollId, optionFor } = await openPollWith(
      w.manager,
      w.outlet.id,
      [w.wrap.id, w.burger.id],
      {
        showLiveResults: true,
      },
    );
    await vote(student, pollId, optionFor(w.wrap.id)).expect(200);
    const other = await signIn('someone.else@example.com');
    const body = JSON.stringify(await currentPoll(other));
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'student@example.com' } });
    expect(body).not.toContain(me.id);
    expect(body).not.toContain('student@example.com');
    expect(JSON.parse(body).myOptionId).toBeNull();
  });
});

describe('concurrency', () => {
  it('never accepts a vote that races with closing the poll', async () => {
    const { pollId, optionFor } = await openPollWith(w.manager, w.outlet.id, [
      w.wrap.id,
      w.burger.id,
    ]);
    const voters = await students(16);

    const [closeRes, ...voteResults] = await Promise.all([
      lifecycle(w.manager, w.outlet.id, pollId, 'close'),
      ...voters.map((v, i) => vote(v, pollId, optionFor(i % 2 ? w.wrap.id : w.burger.id))),
    ]);
    expect(closeRes.status).toBe(200);

    const accepted = voteResults.filter((r) => r.status === 200).length;
    const refused = voteResults.filter(
      (r) => r.status === 409 && r.body.error.code === 'POLL_CLOSED',
    ).length;
    expect(accepted + refused).toBe(voters.length);

    // Exactly the accepted votes exist, and none was written after the poll closed.
    const rows = await votesIn(pollId);
    expect(rows).toHaveLength(accepted);
    const poll = await prisma.dailyPoll.findUniqueOrThrow({ where: { id: pollId } });
    expect(poll.status).not.toBe('OPEN');
    for (const row of rows)
      expect(row.updatedAt.getTime()).toBeLessThanOrEqual(poll.closedAt!.getTime());
    // And the stored result matches those votes.
    if (poll.status === 'FINALIZED') expect(poll.totalVotes).toBe(accepted);

    const late = await vote(voters[0]!, pollId, optionFor(w.wrap.id)).expect(409);
    expect(late.body.error.code).toBe('POLL_CLOSED');
  });
});
