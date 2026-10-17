-- CreateEnum
CREATE TYPE "OrderTiming" AS ENUM ('IMMEDIATE', 'SCHEDULED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "scheduledFeePaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduledFor" TIMESTAMP(3),
ADD COLUMN     "timing" "OrderTiming" NOT NULL DEFAULT 'IMMEDIATE';

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "scheduleDaysAhead" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "scheduleLeadMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "scheduleSlotCapacity" INTEGER,
ADD COLUMN     "scheduleSlotMinutes" INTEGER NOT NULL DEFAULT 15;

-- CreateTable
CREATE TABLE "OutletHours" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "opensMinute" INTEGER NOT NULL,
    "closesMinute" INTEGER NOT NULL,

    CONSTRAINT "OutletHours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutletHours_outletId_weekday_key" ON "OutletHours"("outletId", "weekday");

-- CreateIndex
CREATE INDEX "Order_outletId_scheduledFor_idx" ON "Order"("outletId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "OutletHours" ADD CONSTRAINT "OutletHours_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────

-- Every existing order is IMMEDIATE with no slot and no fee, so all of these already hold.
ALTER TABLE "Order" ADD CONSTRAINT "Order_schedule_matches_timing"
  CHECK (("timing" = 'SCHEDULED') = ("scheduledFor" IS NOT NULL));
ALTER TABLE "Order" ADD CONSTRAINT "Order_scheduled_fee_matches_timing"
  CHECK (("timing" = 'SCHEDULED' AND "scheduledFeePaise" = 1000)
      OR ("timing" = 'IMMEDIATE' AND "scheduledFeePaise" = 0));
-- The total now also carries the scheduled-order fee.
ALTER TABLE "Order" DROP CONSTRAINT "Order_total_after_discount";
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_after_discount"
  CHECK ("totalPaise" = "subtotalPaise" - "pointsDiscountPaise" + "scheduledFeePaise");

ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_schedule_settings_valid"
  CHECK ("scheduleLeadMinutes" BETWEEN 0 AND 1440
     AND "scheduleSlotMinutes" BETWEEN 5 AND 120
     AND "scheduleDaysAhead" BETWEEN 0 AND 14
     AND ("scheduleSlotCapacity" IS NULL OR "scheduleSlotCapacity" BETWEEN 1 AND 500));

ALTER TABLE "OutletHours" ADD CONSTRAINT "OutletHours_valid"
  CHECK ("weekday" BETWEEN 0 AND 6 AND "opensMinute" >= 0 AND "opensMinute" < "closesMinute" AND "closesMinute" <= 1440);
