-- CreateEnum
CREATE TYPE "ReorderSource" AS ENUM ('ORDER', 'SAVED_COMBO', 'SUGGESTED_COMBO', 'POPULAR');

-- CreateTable
CREATE TABLE "SavedMealCombo" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedMealCombo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedMealComboItem" (
    "id" UUID NOT NULL,
    "comboId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "SavedMealComboItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" "ReorderSource" NOT NULL,
    "orderId" UUID,
    "savedComboId" UUID,
    "outletId" UUID NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReorderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedMealCombo_userId_updatedAt_idx" ON "SavedMealCombo"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SavedMealCombo_userId_name_key" ON "SavedMealCombo"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SavedMealCombo_id_outletId_key" ON "SavedMealCombo"("id", "outletId");

-- CreateIndex
CREATE INDEX "SavedMealComboItem_menuItemId_idx" ON "SavedMealComboItem"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedMealComboItem_comboId_menuItemId_key" ON "SavedMealComboItem"("comboId", "menuItemId");

-- CreateIndex
CREATE INDEX "ReorderEvent_userId_createdAt_idx" ON "ReorderEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReorderEvent_outletId_createdAt_idx" ON "ReorderEvent"("outletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderEvent_userId_idempotencyKey_key" ON "ReorderEvent"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "SavedMealCombo" ADD CONSTRAINT "SavedMealCombo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedMealCombo" ADD CONSTRAINT "SavedMealCombo_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedMealComboItem" ADD CONSTRAINT "SavedMealComboItem_comboId_outletId_fkey" FOREIGN KEY ("comboId", "outletId") REFERENCES "SavedMealCombo"("id", "outletId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedMealComboItem" ADD CONSTRAINT "SavedMealComboItem_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderEvent" ADD CONSTRAINT "ReorderEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderEvent" ADD CONSTRAINT "ReorderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderEvent" ADD CONSTRAINT "ReorderEvent_savedComboId_fkey" FOREIGN KEY ("savedComboId") REFERENCES "SavedMealCombo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderEvent" ADD CONSTRAINT "ReorderEvent_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Saved combos: per-item quantity within the cart's limit, a real name, sensible counts.
ALTER TABLE "SavedMealComboItem" ADD CONSTRAINT "SavedMealComboItem_quantity_range" CHECK ("quantity" BETWEEN 1 AND 10);
ALTER TABLE "SavedMealCombo" ADD CONSTRAINT "SavedMealCombo_name_length" CHECK (char_length("name") BETWEEN 1 AND 60);
ALTER TABLE "ReorderEvent" ADD CONSTRAINT "ReorderEvent_counts_valid" CHECK ("itemCount" > 0 AND "totalPaise" >= 0);
-- A reorder names its source: an order for ORDER, a saved combo for SAVED_COMBO (unless it was deleted since).
ALTER TABLE "ReorderEvent" ADD CONSTRAINT "ReorderEvent_source_reference" CHECK (
  ("source" = 'ORDER' AND "orderId" IS NOT NULL) OR ("source" <> 'ORDER' AND "orderId" IS NULL)
);
