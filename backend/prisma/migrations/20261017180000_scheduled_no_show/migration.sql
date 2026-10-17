-- CreateEnum
CREATE TYPE "FoodFulfillment" AS ENUM ('PACKAGED', 'HANDMADE');

-- CreateEnum
CREATE TYPE "NoShowStatus" AS ENUM ('PROCESSED', 'FAILED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'NO_SHOW';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "fulfillmentType" "FoodFulfillment";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "fulfillmentType" "FoodFulfillment",
ADD COLUMN     "noShowFeePaise" INTEGER,
ADD COLUMN     "noShowPaidPaise" INTEGER,
ADD COLUMN     "noShowRefundPaise" INTEGER,
ADD COLUMN     "noShowRestockedQty" INTEGER,
ADD COLUMN     "unsuitableForResale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unsuitableReason" TEXT;

-- CreateTable
CREATE TABLE "NoShowSettlement" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "NoShowStatus" NOT NULL,
    "pickupDeadline" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "refundPaise" INTEGER NOT NULL DEFAULT 0,
    "convenienceFeePaise" INTEGER NOT NULL DEFAULT 0,
    "scheduledFeeRetainedPaise" INTEGER NOT NULL DEFAULT 0,
    "restockedUnits" INTEGER NOT NULL DEFAULT 0,
    "refundTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoShowSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoShowSettlement_orderId_key" ON "NoShowSettlement"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "NoShowSettlement_refundTransactionId_key" ON "NoShowSettlement"("refundTransactionId");

-- CreateIndex
CREATE INDEX "NoShowSettlement_status_idx" ON "NoShowSettlement"("status");

-- AddForeignKey
ALTER TABLE "NoShowSettlement" ADD CONSTRAINT "NoShowSettlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
