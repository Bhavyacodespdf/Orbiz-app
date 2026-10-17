-- CreateEnum
CREATE TYPE "GroupTrayStatus" AS ENUM ('ACTIVE', 'CHECKOUT', 'ORDERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GroupMemberRole" AS ENUM ('HOST', 'MEMBER');

-- CreateEnum
CREATE TYPE "GroupMemberStatus" AS ENUM ('ACTIVE', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "AllocationMode" AS ENUM ('BY_DISH', 'EQUAL', 'PERCENTAGE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "GroupSettlementStatus" AS ENUM ('OPEN', 'ORDERED', 'VOID');

-- CreateEnum
CREATE TYPE "ShareStatus" AS ENUM ('NOTHING_DUE', 'UNPAID', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BanquetEventType" AS ENUM ('PROJECT_LUNCH', 'BIRTHDAY', 'CLUB_EVENT', 'ACADEMIC_EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "BanquetStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PeerSplitMethod" AS ENUM ('EQUAL', 'PERCENTAGE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PeerSplitStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PeerParticipantStatus" AS ENUM ('OWNER', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PeerSettlementStatus" AS ENUM ('COMPLETED', 'REVERSED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'GROUP';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTransactionType" ADD VALUE 'GROUP_SHARE_PAYMENT';
ALTER TYPE "WalletTransactionType" ADD VALUE 'PEER_TRANSFER_OUT';
ALTER TYPE "WalletTransactionType" ADD VALUE 'PEER_TRANSFER_IN';

-- CreateTable
CREATE TABLE "GroupTray" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "outletId" UUID NOT NULL,
    "hostUserId" UUID NOT NULL,
    "status" "GroupTrayStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxMembers" INTEGER NOT NULL,
    "joinClosesAt" TIMESTAMP(3),
    "allocationMode" "AllocationMode" NOT NULL DEFAULT 'BY_DISH',
    "version" INTEGER NOT NULL DEFAULT 1,
    "orderId" UUID,
    "checkoutAt" TIMESTAMP(3),
    "orderedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupTray_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "GroupMemberRole" NOT NULL,
    "status" "GroupMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "percentBps" INTEGER,
    "customAmountPaise" INTEGER,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupItem" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupSettlement" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "GroupSettlementStatus" NOT NULL DEFAULT 'OPEN',
    "mode" "AllocationMode" NOT NULL,
    "inputs" JSONB NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "voidReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupSettlementLine" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotalPaise" INTEGER NOT NULL,

    CONSTRAINT "GroupSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupShare" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amountDuePaise" INTEGER NOT NULL,
    "ownItemsPaise" INTEGER NOT NULL,
    "amountPaidPaise" INTEGER NOT NULL DEFAULT 0,
    "status" "ShareStatus" NOT NULL,
    "paymentTransactionId" UUID,
    "refundTransactionId" UUID,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "GroupShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupEvent" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actorUserId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BanquetSettings" (
    "outletId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxGuests" INTEGER NOT NULL DEFAULT 40,
    "minNoticeDays" INTEGER NOT NULL DEFAULT 2,
    "maxConcurrentEvents" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BanquetSettings_pkey" PRIMARY KEY ("outletId")
);

-- CreateTable
CREATE TABLE "BanquetBooking" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "hostUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "eventType" "BanquetEventType" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "guestCount" INTEGER NOT NULL,
    "dietaryNotes" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "contactPhone" TEXT,
    "status" "BanquetStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "estimatedTotalPaise" INTEGER NOT NULL,
    "perGuestPaise" INTEGER NOT NULL,
    "passToken" TEXT NOT NULL,
    "decisionReason" TEXT,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BanquetBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BanquetBookingItem" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotalPaise" INTEGER NOT NULL,

    CONSTRAINT "BanquetBookingItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BanquetStatusHistory" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "fromStatus" "BanquetStatus",
    "toStatus" "BanquetStatus" NOT NULL,
    "actorUserId" UUID NOT NULL,
    "actorRole" "Role" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BanquetStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeerSplit" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "totalPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "expenseDate" DATE NOT NULL,
    "dueDate" DATE,
    "method" "PeerSplitMethod" NOT NULL,
    "status" "PeerSplitStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeerSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeerSplitParticipant" (
    "id" UUID NOT NULL,
    "splitId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "percentBps" INTEGER,
    "customAmountPaise" INTEGER,
    "amountDuePaise" INTEGER NOT NULL,
    "amountPaidPaise" INTEGER NOT NULL DEFAULT 0,
    "status" "PeerParticipantStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeerSplitParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeerSplitSettlement" (
    "id" UUID NOT NULL,
    "splitId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "payerUserId" UUID NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "debitTransactionId" UUID NOT NULL,
    "creditTransactionId" UUID NOT NULL,
    "status" "PeerSettlementStatus" NOT NULL DEFAULT 'COMPLETED',
    "reversalDebitTransactionId" UUID,
    "reversalCreditTransactionId" UUID,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeerSplitSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupTray_code_key" ON "GroupTray"("code");

-- CreateIndex
CREATE UNIQUE INDEX "GroupTray_orderId_key" ON "GroupTray"("orderId");

-- CreateIndex
CREATE INDEX "GroupTray_hostUserId_idx" ON "GroupTray"("hostUserId");

-- CreateIndex
CREATE INDEX "GroupTray_outletId_status_idx" ON "GroupTray"("outletId", "status");

-- CreateIndex
CREATE INDEX "GroupMember_userId_status_idx" ON "GroupMember"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");

-- CreateIndex
CREATE INDEX "GroupItem_groupId_idx" ON "GroupItem"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupItem_memberId_menuItemId_key" ON "GroupItem"("memberId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupSettlement_groupId_version_key" ON "GroupSettlement"("groupId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "GroupSettlementLine_settlementId_memberId_menuItemId_key" ON "GroupSettlementLine"("settlementId", "memberId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupShare_paymentTransactionId_key" ON "GroupShare"("paymentTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupShare_refundTransactionId_key" ON "GroupShare"("refundTransactionId");

-- CreateIndex
CREATE INDEX "GroupShare_userId_idx" ON "GroupShare"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupShare_settlementId_memberId_key" ON "GroupShare"("settlementId", "memberId");

-- CreateIndex
CREATE INDEX "GroupEvent_groupId_createdAt_idx" ON "GroupEvent"("groupId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BanquetBooking_passToken_key" ON "BanquetBooking"("passToken");

-- CreateIndex
CREATE INDEX "BanquetBooking_outletId_startsAt_idx" ON "BanquetBooking"("outletId", "startsAt");

-- CreateIndex
CREATE INDEX "BanquetBooking_hostUserId_startsAt_idx" ON "BanquetBooking"("hostUserId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BanquetBookingItem_bookingId_menuItemId_key" ON "BanquetBookingItem"("bookingId", "menuItemId");

-- CreateIndex
CREATE INDEX "BanquetStatusHistory_bookingId_createdAt_idx" ON "BanquetStatusHistory"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "PeerSplit_ownerUserId_createdAt_idx" ON "PeerSplit"("ownerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PeerSplitParticipant_userId_idx" ON "PeerSplitParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerSplitParticipant_splitId_userId_key" ON "PeerSplitParticipant"("splitId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerSplitSettlement_idempotencyKey_key" ON "PeerSplitSettlement"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PeerSplitSettlement_debitTransactionId_key" ON "PeerSplitSettlement"("debitTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerSplitSettlement_creditTransactionId_key" ON "PeerSplitSettlement"("creditTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerSplitSettlement_reversalDebitTransactionId_key" ON "PeerSplitSettlement"("reversalDebitTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerSplitSettlement_reversalCreditTransactionId_key" ON "PeerSplitSettlement"("reversalCreditTransactionId");

-- CreateIndex
CREATE INDEX "PeerSplitSettlement_splitId_idx" ON "PeerSplitSettlement"("splitId");

-- CreateIndex
CREATE INDEX "PeerSplitSettlement_payerUserId_createdAt_idx" ON "PeerSplitSettlement"("payerUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "GroupTray" ADD CONSTRAINT "GroupTray_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupTray" ADD CONSTRAINT "GroupTray_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupTray" ADD CONSTRAINT "GroupTray_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupTray"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupItem" ADD CONSTRAINT "GroupItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupTray"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupItem" ADD CONSTRAINT "GroupItem_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "GroupMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupItem" ADD CONSTRAINT "GroupItem_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSettlement" ADD CONSTRAINT "GroupSettlement_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupTray"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSettlement" ADD CONSTRAINT "GroupSettlement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSettlementLine" ADD CONSTRAINT "GroupSettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "GroupSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSettlementLine" ADD CONSTRAINT "GroupSettlementLine_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "GroupMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShare" ADD CONSTRAINT "GroupShare_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "GroupSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShare" ADD CONSTRAINT "GroupShare_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "GroupMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShare" ADD CONSTRAINT "GroupShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShare" ADD CONSTRAINT "GroupShare_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShare" ADD CONSTRAINT "GroupShare_refundTransactionId_fkey" FOREIGN KEY ("refundTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupEvent" ADD CONSTRAINT "GroupEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupTray"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupEvent" ADD CONSTRAINT "GroupEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetSettings" ADD CONSTRAINT "BanquetSettings_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetSettings" ADD CONSTRAINT "BanquetSettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetBooking" ADD CONSTRAINT "BanquetBooking_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetBooking" ADD CONSTRAINT "BanquetBooking_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetBooking" ADD CONSTRAINT "BanquetBooking_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetBookingItem" ADD CONSTRAINT "BanquetBookingItem_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BanquetBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetBookingItem" ADD CONSTRAINT "BanquetBookingItem_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetStatusHistory" ADD CONSTRAINT "BanquetStatusHistory_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BanquetBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanquetStatusHistory" ADD CONSTRAINT "BanquetStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplit" ADD CONSTRAINT "PeerSplit_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitParticipant" ADD CONSTRAINT "PeerSplitParticipant_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "PeerSplit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitParticipant" ADD CONSTRAINT "PeerSplitParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "PeerSplit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "PeerSplitParticipant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_payerUserId_fkey" FOREIGN KEY ("payerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_debitTransactionId_fkey" FOREIGN KEY ("debitTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_reversalDebitTransactionId_fkey" FOREIGN KEY ("reversalDebitTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_reversalCreditTransactionId_fkey" FOREIGN KEY ("reversalCreditTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity rules that don't use the new enum values (those are in the next migration).
ALTER TABLE "GroupTray" ADD CONSTRAINT "GroupTray_valid" CHECK (
  "maxMembers" BETWEEN 2 AND 20 AND "version" >= 1
  AND char_length("code") BETWEEN 8 AND 32
  AND char_length("name") BETWEEN 1 AND 60
);
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_split_inputs_valid" CHECK (
  ("percentBps" IS NULL OR "percentBps" BETWEEN 0 AND 10000)
  AND ("customAmountPaise" IS NULL OR "customAmountPaise" >= 0)
);
ALTER TABLE "GroupItem" ADD CONSTRAINT "GroupItem_quantity_range" CHECK ("quantity" BETWEEN 1 AND 10);
ALTER TABLE "GroupSettlement" ADD CONSTRAINT "GroupSettlement_amounts_valid" CHECK (
  "subtotalPaise" > 0 AND "totalPaise" = "subtotalPaise" AND "version" >= 1
);
ALTER TABLE "GroupSettlementLine" ADD CONSTRAINT "GroupSettlementLine_amounts_valid" CHECK (
  "quantity" BETWEEN 1 AND 10 AND "unitPricePaise" > 0
  AND "lineTotalPaise" = "unitPricePaise" * "quantity"
);
ALTER TABLE "GroupShare" ADD CONSTRAINT "GroupShare_amounts_valid" CHECK (
  "amountDuePaise" >= 0 AND "ownItemsPaise" >= 0
  AND "amountPaidPaise" >= 0 AND "amountPaidPaise" <= "amountDuePaise"
  AND ("status" <> 'NOTHING_DUE' OR "amountDuePaise" = 0)
  AND ("status" <> 'PAID' OR ("amountPaidPaise" = "amountDuePaise" AND "paymentTransactionId" IS NOT NULL AND "paidAt" IS NOT NULL))
  AND ("status" <> 'UNPAID' OR ("amountPaidPaise" = 0 AND "amountDuePaise" > 0))
  AND ("status" <> 'REFUNDED' OR ("refundTransactionId" IS NOT NULL AND "refundedAt" IS NOT NULL))
);
-- One open or ordered checkout per group at a time; voided ones stay as history.
CREATE UNIQUE INDEX "GroupSettlement_one_live" ON "GroupSettlement" ("groupId") WHERE "status" <> 'VOID';
-- One active host per group.
CREATE UNIQUE INDEX "GroupMember_one_host" ON "GroupMember" ("groupId") WHERE "role" = 'HOST';

ALTER TABLE "BanquetSettings" ADD CONSTRAINT "BanquetSettings_valid" CHECK (
  "maxGuests" BETWEEN 1 AND 1000 AND "minNoticeDays" BETWEEN 0 AND 60
  AND "maxConcurrentEvents" BETWEEN 1 AND 20
);
ALTER TABLE "BanquetBooking" ADD CONSTRAINT "BanquetBooking_valid" CHECK (
  "endsAt" > "startsAt" AND "guestCount" BETWEEN 1 AND 1000
  AND "estimatedTotalPaise" > 0 AND "perGuestPaise" >= 0 AND "version" >= 1
);
ALTER TABLE "BanquetBookingItem" ADD CONSTRAINT "BanquetBookingItem_amounts_valid" CHECK (
  "quantity" BETWEEN 1 AND 1000 AND "unitPricePaise" > 0
  AND "lineTotalPaise" = "unitPricePaise" * "quantity"
);

ALTER TABLE "PeerSplit" ADD CONSTRAINT "PeerSplit_valid" CHECK (
  "totalPaise" > 0 AND "totalPaise" <= 10000000 AND "currency" = 'INR' AND "version" >= 1
);
ALTER TABLE "PeerSplitParticipant" ADD CONSTRAINT "PeerSplitParticipant_amounts_valid" CHECK (
  "amountDuePaise" >= 0 AND "amountPaidPaise" >= 0 AND "amountPaidPaise" <= "amountDuePaise"
  AND ("percentBps" IS NULL OR "percentBps" BETWEEN 0 AND 10000)
  AND ("customAmountPaise" IS NULL OR "customAmountPaise" >= 0)
);
ALTER TABLE "PeerSplitSettlement" ADD CONSTRAINT "PeerSplitSettlement_valid" CHECK (
  "amountPaise" > 0 AND "payerUserId" <> "recipientUserId"
  AND (("status" = 'REVERSED') = ("reversedAt" IS NOT NULL
       AND "reversalDebitTransactionId" IS NOT NULL AND "reversalCreditTransactionId" IS NOT NULL))
);

-- A group order combines every member's quantity of a dish into one line (up to 20 × 10).
-- Carts keep their own 1–10 limit.
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_amounts_valid";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_amounts_valid" CHECK (
  "quantity" BETWEEN 1 AND 200 AND "unitPricePaise" > 0 AND "lineTotalPaise" = "unitPricePaise" * "quantity"
);
