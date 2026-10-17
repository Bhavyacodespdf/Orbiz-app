import { Router, type Request } from 'express';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import { istDay } from '../orders/pickup.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import {
  createPollBody,
  finalizeBody,
  historyQuery,
  specialsQuery,
  updatePollBody,
  voteBody,
} from './polls.schema.js';
import {
  castVote,
  closePoll,
  createPoll,
  currentPollId,
  dateColumn,
  dbNow,
  deleteDraft,
  finalizePoll,
  openPoll,
  pollInclude,
  settleDue,
  settlePolls,
  updateDraft,
  voteCounts,
} from './polls.service.js';
import { toManagerPoll, toSpecial, toStudentPoll } from './polls.serializer.js';
import type { PollChange, RealtimePublisher } from '../../realtime/publisher.js';

function idParam(req: Request, name: string): string {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** :slug comes from the mount path (mergeParams). */
const slugParam = (req: Request) => String((req.params as Record<string, string>).slug ?? '');

const actorOf = (req: Request) => ({ type: 'USER' as const, userId: req.auth!.user.id });

async function findActiveOutlet(db: Database, slug: string) {
  const outlet = await db.outlet.findFirst({ where: { slug, isActive: true } });
  if (!outlet) throw notFound('Outlet not found');
  return outlet;
}

async function studentView(db: Database, pollId: string, userId: string) {
  const [poll, counts, mine, now] = await Promise.all([
    db.dailyPoll.findUniqueOrThrow({ where: { id: pollId }, include: pollInclude }),
    voteCounts(db, pollId),
    db.dailyPollVote.findUnique({
      where: { pollId_userId: { pollId, userId } },
      select: { optionId: true },
    }),
    dbNow(db),
  ]);
  return toStudentPoll(poll, counts, now, mine?.optionId ?? null);
}

async function managerView(db: Database, outletId: string, pollId: string) {
  const poll = await db.dailyPoll.findFirst({
    where: { id: pollId, outletId },
    include: pollInclude,
  });
  if (!poll) throw notFound('Poll not found');
  const [counts, now] = await Promise.all([voteCounts(db, pollId), dbNow(db)]);
  return toManagerPoll(poll, counts, now);
}

const specialInclude = { ...pollInclude, outlet: true } as const;

/** Announces a committed poll change (IDs, status and version only). */
const announce = (
  realtime: RealtimePublisher,
  poll: { id: string; outletId: string; status: string; version: number },
  change: PollChange,
) => realtime.pollUpdated(poll, change);

/**
 * Mounted at /outlets/:slug, ahead of the public outlet routes.
 *  GET /poll     the poll a signed-in student can vote in (or null)
 *  GET /special  the outlet's Today's Special for a date — public, aggregates only
 */
export function outletPollRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });

  router.get('/poll', requireAuth, async (req, res) => {
    const outlet = await findActiveOutlet(db, slugParam(req));
    await settleDue(db, { outletId: outlet.id }, realtime);
    const pollId = await currentPollId(db, outlet.id);
    res.json({ poll: pollId ? await studentView(db, pollId, req.auth!.user.id) : null });
  });

  router.get('/special', async (req, res) => {
    const outlet = await findActiveOutlet(db, slugParam(req));
    const day = specialsQuery.parse(req.query).day ?? istDay(await dbNow(db));
    await settleDue(db, { outletId: outlet.id, day: dateColumn(day) }, realtime);
    const poll = await db.dailyPoll.findFirst({
      where: { outletId: outlet.id, day: dateColumn(day), status: 'FINALIZED' },
      include: specialInclude,
    });
    res.json({ day, special: poll ? toSpecial(poll) : null });
  });

  return router;
}

/** GET /specials?day= — every active outlet's Today's Special for a date. Public. */
export function specialsRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router();
  router.get('/', async (req, res) => {
    const day = specialsQuery.parse(req.query).day ?? istDay(await dbNow(db));
    await settleDue(db, { day: dateColumn(day), outlet: { isActive: true } }, realtime);
    const polls = await db.dailyPoll.findMany({
      where: {
        day: dateColumn(day),
        status: 'FINALIZED',
        winnerOptionId: { not: null },
        outlet: { isActive: true },
      },
      include: specialInclude,
      orderBy: { outlet: { name: 'asc' } },
    });
    res.json({ day, specials: polls.map(toSpecial).filter((s) => s !== null) });
  });
  return router;
}

/** POST /polls/:pollId/vote — cast or change the signed-in student's vote. */
export function votesRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router();
  router.post('/:pollId/vote', requireAuth, requireRole('STUDENT'), async (req, res) => {
    const pollId = idParam(req, 'pollId');
    const { optionId } = voteBody.parse(req.body);
    const userId = req.auth!.user.id;
    await castVote(db, { pollId, optionId, userId });
    const poll = await studentView(db, pollId, userId);
    // Only the outlet's staff hear about counts changing; never who voted.
    announce(realtime, { ...poll, status: 'OPEN' }, 'staff');
    res.json({ poll });
  });
  return router;
}

/**
 * Mounted at /staff/outlets/:outletId/polls. Managers assigned to the outlet only;
 * every lookup is scoped by outletId, so another outlet's poll IDs resolve to 404.
 */
export function staffPollsRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER'));

  router.get('/', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const { limit, before } = historyQuery.parse(req.query);
    await settleDue(db, { outletId }, realtime);
    const rows = await db.dailyPoll.findMany({
      where: { outletId, ...(before && { day: { lt: dateColumn(before) } }) },
      include: pollInclude,
      orderBy: { day: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const now = await dbNow(db);
    const polls = await Promise.all(
      page.map(async (p) => toManagerPoll(p, await voteCounts(db, p.id), now)),
    );
    res.json({ polls, nextBefore: rows.length > limit ? polls[polls.length - 1]!.day : null });
  });

  router.post('/', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = createPollBody.parse(req.body);
    const pollId = await createPoll(db, outletId, body, actorOf(req));
    const poll = await managerView(db, outletId, pollId);
    announce(realtime, poll, 'staff');
    res.status(201).json({ poll });
  });

  router.get('/:pollId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const pollId = idParam(req, 'pollId');
    await managerView(db, outletId, pollId); // 404 before touching anything
    await settlePolls(db, [pollId], realtime);
    res.json({ poll: await managerView(db, outletId, pollId) });
  });

  router.patch('/:pollId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const pollId = idParam(req, 'pollId');
    await updateDraft(db, outletId, pollId, updatePollBody.parse(req.body), actorOf(req));
    const poll = await managerView(db, outletId, pollId);
    announce(realtime, poll, 'staff');
    res.json({ poll });
  });

  router.delete('/:pollId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const pollId = idParam(req, 'pollId');
    await deleteDraft(db, outletId, pollId, actorOf(req));
    announce(realtime, { id: pollId, outletId, status: 'DELETED', version: 0 }, 'staff');
    res.status(204).end();
  });

  router.post('/:pollId/open', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const pollId = idParam(req, 'pollId');
    await openPoll(db, outletId, pollId, actorOf(req));
    const poll = await managerView(db, outletId, pollId);
    announce(realtime, poll, 'status');
    res.json({ poll });
  });

  router.post('/:pollId/close', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const pollId = idParam(req, 'pollId');
    await closePoll(db, outletId, pollId, actorOf(req), realtime);
    const poll = await managerView(db, outletId, pollId);
    announce(realtime, poll, 'status');
    res.json({ poll });
  });

  router.post('/:pollId/finalize', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const pollId = idParam(req, 'pollId');
    const { tieBreakOptionId } = finalizeBody.parse(req.body ?? {});
    try {
      await finalizePoll(db, pollId, { actor: actorOf(req), outletId, tieBreakOptionId });
    } finally {
      // Even a refused finalize may have closed an expired poll first; announce what is stored.
      const stored = await db.dailyPoll.findFirst({ where: { id: pollId, outletId } });
      if (stored) announce(realtime, stored, 'status');
    }
    res.json({ poll: await managerView(db, outletId, pollId) });
  });

  return router;
}
