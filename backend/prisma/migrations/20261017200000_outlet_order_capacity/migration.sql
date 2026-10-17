-- CreateTable
CREATE TABLE "OutletOrderAcceptance" (
    "orderId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutletOrderAcceptance_pkey" PRIMARY KEY ("orderId")
);

-- CreateIndex
CREATE INDEX "OutletOrderAcceptance_outletId_acceptedAt_idx" ON "OutletOrderAcceptance"("outletId", "acceptedAt");

-- AddForeignKey
ALTER TABLE "OutletOrderAcceptance" ADD CONSTRAINT "OutletOrderAcceptance_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletOrderAcceptance" ADD CONSTRAINT "OutletOrderAcceptance_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Orders placed in the last 3 minutes before this migration still count toward the window.
INSERT INTO "OutletOrderAcceptance" ("orderId", "outletId", "acceptedAt")
SELECT "id", "outletId", "placedAt" FROM "Order"
WHERE "placedAt" > (now() AT TIME ZONE 'UTC') - interval '3 minutes';
