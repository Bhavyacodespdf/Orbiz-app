-- CreateTable
CREATE TABLE "CounterPayment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "recordedById" UUID NOT NULL,
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounterPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CounterPayment_orderId_key" ON "CounterPayment"("orderId");

-- AddForeignKey
ALTER TABLE "CounterPayment" ADD CONSTRAINT "CounterPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CounterPayment" ADD CONSTRAINT "CounterPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: amounts are positive integer paise.
ALTER TABLE "CounterPayment" ADD CONSTRAINT "CounterPayment_amount_positive" CHECK ("amountPaise" > 0);
