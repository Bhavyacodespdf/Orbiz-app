-- CreateEnum
CREATE TYPE "LoyaltyTransactionType" AS ENUM ('EARNED_RECHARGE', 'REDEEMED_ORDER', 'RESTORED_ORDER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "pointsDiscountPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsRedeemed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "bonusPoints" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "pointsBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "type" "LoyaltyTransactionType" NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "points" INTEGER NOT NULL,
    "pointsBalanceAfter" INTEGER NOT NULL,
    "paymentAttemptId" UUID,
    "orderId" UUID,
    "reversesId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isSimulated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_paymentAttemptId_key" ON "LoyaltyTransaction"("paymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_reversesId_key" ON "LoyaltyTransaction"("reversesId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_idempotencyKey_key" ON "LoyaltyTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_walletId_createdAt_idx" ON "LoyaltyTransaction"("walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_orderId_type_key" ON "LoyaltyTransaction"("orderId", "type");

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "LoyaltyTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_points_non_negative" CHECK ("pointsBalance" >= 0);
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_bonus_non_negative" CHECK ("bonusPoints" >= 0);

-- Existing orders have no discount and total = subtotal, so they already satisfy these.
ALTER TABLE "Order" ADD CONSTRAINT "Order_points_non_negative" CHECK ("pointsRedeemed" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_points_discount_matches"
  CHECK ("pointsDiscountPaise" = "pointsRedeemed" * 100);
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_after_discount"
  CHECK ("totalPaise" = "subtotalPaise" - "pointsDiscountPaise");
-- Points never cover the whole order: at least ₹1 is always left to pay.
ALTER TABLE "Order" ADD CONSTRAINT "Order_points_leave_payment"
  CHECK ("pointsRedeemed" = 0 OR "totalPaise" >= 100);

ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_points_positive" CHECK ("points" > 0);
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_balance_non_negative"
  CHECK ("pointsBalanceAfter" >= 0);
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_direction_matches_type"
  CHECK (("type" = 'REDEEMED_ORDER') = ("direction" = 'DEBIT'));
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_links_match_type"
  CHECK (
    ("type" = 'EARNED_RECHARGE' AND "paymentAttemptId" IS NOT NULL AND "orderId" IS NULL AND "reversesId" IS NULL)
    OR ("type" = 'REDEEMED_ORDER' AND "orderId" IS NOT NULL AND "paymentAttemptId" IS NULL AND "reversesId" IS NULL)
    OR ("type" = 'RESTORED_ORDER' AND "orderId" IS NOT NULL AND "paymentAttemptId" IS NULL AND "reversesId" IS NOT NULL)
  );
