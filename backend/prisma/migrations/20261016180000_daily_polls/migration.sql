-- CreateEnum
CREATE TYPE "DailyPollStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'FINALIZED');

-- CreateEnum
CREATE TYPE "DailyPollOutcome" AS ENUM ('WINNER', 'TIE_RESOLVED_BY_MANAGER', 'NO_VOTES');

-- CreateTable
CREATE TABLE "DailyPoll" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "status" "DailyPollStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "showLiveResults" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "outcome" "DailyPollOutcome",
    "winnerOptionId" UUID,
    "totalVotes" INTEGER,
    "winnerVotes" INTEGER,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPollOption" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyPollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPollVote" (
    "id" UUID NOT NULL,
    "pollId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyPoll_day_status_idx" ON "DailyPoll"("day", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPoll_outletId_day_key" ON "DailyPoll"("outletId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPoll_id_outletId_key" ON "DailyPoll"("id", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPollOption_pollId_menuItemId_key" ON "DailyPollOption"("pollId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPollOption_id_pollId_key" ON "DailyPollOption"("id", "pollId");

-- CreateIndex
CREATE INDEX "DailyPollVote_pollId_optionId_idx" ON "DailyPollVote"("pollId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPollVote_pollId_userId_key" ON "DailyPollVote"("pollId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_id_outletId_key" ON "MenuItem"("id", "outletId");

-- AddForeignKey
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_winnerOptionId_id_fkey" FOREIGN KEY ("winnerOptionId", "id") REFERENCES "DailyPollOption"("id", "pollId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPollOption" ADD CONSTRAINT "DailyPollOption_pollId_outletId_fkey" FOREIGN KEY ("pollId", "outletId") REFERENCES "DailyPoll"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPollOption" ADD CONSTRAINT "DailyPollOption_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPollVote" ADD CONSTRAINT "DailyPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "DailyPoll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPollVote" ADD CONSTRAINT "DailyPollVote_optionId_pollId_fkey" FOREIGN KEY ("optionId", "pollId") REFERENCES "DailyPollOption"("id", "pollId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPollVote" ADD CONSTRAINT "DailyPollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────

ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_window_valid" CHECK ("closesAt" > "opensAt");
-- A result exists exactly when the poll is FINALIZED.
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_outcome_iff_finalized"
  CHECK (("status" = 'FINALIZED') = ("outcome" IS NOT NULL AND "finalizedAt" IS NOT NULL AND "totalVotes" IS NOT NULL));
-- No winner is ever recorded for a poll nobody voted in, and every other outcome has one.
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_winner_matches_outcome"
  CHECK (("winnerOptionId" IS NULL) = ("outcome" IS NULL OR "outcome" = 'NO_VOTES'));
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_vote_totals_valid"
  CHECK ("totalVotes" IS NULL OR ("totalVotes" >= 0 AND ("winnerVotes" IS NULL OR "winnerVotes" BETWEEN 1 AND "totalVotes")));
ALTER TABLE "DailyPoll" ADD CONSTRAINT "DailyPoll_no_votes_means_zero"
  CHECK ("outcome" IS DISTINCT FROM 'NO_VOTES' OR ("totalVotes" = 0 AND "winnerVotes" IS NULL));
