-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ORDER_PLACED', 'ORDER_ACCEPTED', 'ORDER_PREPARING', 'ORDER_ETA_CHANGED', 'ORDER_ALMOST_READY', 'ORDER_READY', 'ORDER_COLLECTED', 'ORDER_REJECTED', 'ORDER_CANCELLED', 'ORDER_NO_SHOW', 'SCHEDULED_PICKUP_SOON', 'PICKUP_DEADLINE_SOON', 'REVIEW_PROMPT', 'STAFF_MANUAL_REVIEW', 'STAFF_ORDER_DELAYED', 'STAFF_CAPACITY_FULL', 'MANAGER_QUEUE_DELAYS', 'MANAGER_AUTO_ACCEPT_FAILURES', 'MANAGER_DELIVERY_FAILURES');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "AutoAcceptMode" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "EstimateSource" AS ENUM ('HISTORY', 'CONFIGURED', 'DEFAULT');

-- CreateEnum
CREATE TYPE "PredictionKind" AS ENUM ('AT_ACCEPT', 'AT_PREP_START');

-- CreateEnum
CREATE TYPE "AutoAcceptOutcome" AS ENUM ('ACCEPTED', 'MANUAL_REVIEW', 'ALREADY_HANDLED');

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "autoAcceptMaxWaitMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "autoAcceptMode" "AutoAcceptMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "kitchenParallelOrders" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "prepMinutes" INTEGER,
ADD COLUMN     "prepUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "entityType" TEXT,
    "entityId" UUID,
    "outletId" UUID,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "deliveryStatus" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrepTimeStat" (
    "menuItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "emaSeconds" DOUBLE PRECISION NOT NULL,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "lastDurationSeconds" INTEGER,
    "lastObservedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrepTimeStat_pkey" PRIMARY KEY ("menuItemId")
);

-- CreateTable
CREATE TABLE "OutletKitchenStat" (
    "outletId" UUID NOT NULL,
    "calibrationFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutletKitchenStat_pkey" PRIMARY KEY ("outletId")
);

-- CreateTable
CREATE TABLE "OrderEstimate" (
    "orderId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "queuePosition" INTEGER,
    "ordersAhead" INTEGER NOT NULL,
    "prepMinutes" DOUBLE PRECISION NOT NULL,
    "predictedStartAt" TIMESTAMP(3),
    "predictedReadyAt" TIMESTAMP(3) NOT NULL,
    "rangeMinutes" DOUBLE PRECISION,
    "notifiedReadyAt" TIMESTAMP(3),
    "etaNoticeCount" INTEGER NOT NULL DEFAULT 0,
    "version" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderEstimate_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "OrderPrediction" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "kind" "PredictionKind" NOT NULL,
    "predictedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "predictedReadyAt" TIMESTAMP(3) NOT NULL,
    "version" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "actualReadyAt" TIMESTAMP(3),
    "absErrorSeconds" INTEGER,

    CONSTRAINT "OrderPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoAcceptDecision" (
    "orderId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "outcome" "AutoAcceptOutcome" NOT NULL,
    "reasons" TEXT[],
    "ruleVersion" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoAcceptDecision_pkey" PRIMARY KEY ("orderId")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_deliveryStatus_nextAttemptAt_idx" ON "Notification"("deliveryStatus", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "OrderEstimate_outletId_idx" ON "OrderEstimate"("outletId");

-- CreateIndex
CREATE INDEX "OrderPrediction_outletId_predictedAt_idx" ON "OrderPrediction"("outletId", "predictedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPrediction_orderId_kind_key" ON "OrderPrediction"("orderId", "kind");

-- CreateIndex
CREATE INDEX "AutoAcceptDecision_outletId_decidedAt_idx" ON "AutoAcceptDecision"("outletId", "decidedAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrepTimeStat" ADD CONSTRAINT "PrepTimeStat_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletKitchenStat" ADD CONSTRAINT "OutletKitchenStat_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEstimate" ADD CONSTRAINT "OrderEstimate_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPrediction" ADD CONSTRAINT "OrderPrediction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoAcceptDecision" ADD CONSTRAINT "AutoAcceptDecision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Kitchen settings and preparation times stay within sensible bounds.
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_kitchen_parallel_range" CHECK ("kitchenParallelOrders" BETWEEN 1 AND 20);
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_auto_accept_wait_range" CHECK ("autoAcceptMaxWaitMinutes" BETWEEN 5 AND 120);
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_prep_minutes_range" CHECK ("prepMinutes" IS NULL OR "prepMinutes" BETWEEN 1 AND 180);
ALTER TABLE "PrepTimeStat" ADD CONSTRAINT "PrepTimeStat_positive" CHECK ("emaSeconds" > 0 AND "observations" >= 0);
ALTER TABLE "OutletKitchenStat" ADD CONSTRAINT "OutletKitchenStat_factor_range" CHECK ("calibrationFactor" BETWEEN 0.5 AND 3);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_attempts_nonnegative" CHECK ("deliveryAttempts" >= 0);
