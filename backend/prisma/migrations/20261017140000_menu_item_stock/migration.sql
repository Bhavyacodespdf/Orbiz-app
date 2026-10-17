-- CreateEnum
CREATE TYPE "StockAdjustmentType" AS ENUM ('RESTOCK', 'REMOVAL', 'COUNT_SET', 'ORDER_DEDUCTION', 'ORDER_RESTORE', 'TRACKING_ENABLED', 'TRACKING_DISABLED', 'THRESHOLD_CHANGED', 'MARKED_SOLD_OUT', 'MARKED_AVAILABLE');

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stockQuantity" INTEGER,
ADD COLUMN     "stockUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "type" "StockAdjustmentType" NOT NULL,
    "quantityChange" INTEGER NOT NULL,
    "previousQuantity" INTEGER,
    "resultingQuantity" INTEGER,
    "orderId" UUID,
    "actorUserId" UUID,
    "actorRole" "Role",
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockAdjustment_outletId_createdAt_idx" ON "StockAdjustment"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "StockAdjustment_menuItemId_createdAt_idx" ON "StockAdjustment"("menuItemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockAdjustment_orderId_menuItemId_type_key" ON "StockAdjustment"("orderId", "menuItemId", "type");

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────

-- Existing items keep trackInventory = false and stockQuantity = NULL: no quantities are invented.
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_stock_matches_tracking"
  CHECK ("trackInventory" = ("stockQuantity" IS NOT NULL));
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_stock_range"
  CHECK ("stockQuantity" IS NULL OR "stockQuantity" BETWEEN 0 AND 100000);
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_threshold_range"
  CHECK ("lowStockThreshold" BETWEEN 0 AND 10000);

ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_quantities_valid"
  CHECK (("previousQuantity" IS NULL OR "previousQuantity" >= 0)
     AND ("resultingQuantity" IS NULL OR "resultingQuantity" >= 0));
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_order_link"
  CHECK (("type" IN ('ORDER_DEDUCTION', 'ORDER_RESTORE')) = ("orderId" IS NOT NULL));
