-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('WALLET', 'COUNTER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING_COUNTER', 'PAID', 'REFUNDED', 'VOID');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('RECHARGE', 'ORDER_DEBIT', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('WALLET_RECHARGE');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Cart" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outletId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "id" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutletDailyCounter" (
    "outletId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutletDailyCounter_pkey" PRIMARY KEY ("outletId","day")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "pickupDay" DATE NOT NULL,
    "pickupNumber" INTEGER NOT NULL,
    "pickupCode" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PLACED',
    "paymentMethod" "PaymentMethod" NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "idempotencyKey" TEXT NOT NULL,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotalPaise" INTEGER NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorUserId" UUID,
    "actorRole" "Role",
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "balancePaise" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "balanceAfterPaise" INTEGER,
    "status" "WalletTransactionStatus" NOT NULL,
    "orderId" UUID,
    "paymentAttemptId" UUID,
    "reversesTransactionId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isSimulated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerReference" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentAttemptStatus" NOT NULL,
    "isSimulated" BOOLEAN NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cart_userId_key" ON "Cart"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_menuItemId_key" ON "CartItem"("cartId", "menuItemId");

-- CreateIndex
CREATE INDEX "Order_outletId_status_placedAt_idx" ON "Order"("outletId", "status", "placedAt");

-- CreateIndex
CREATE INDEX "Order_userId_placedAt_idx" ON "Order"("userId", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key" ON "Order"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Order_outletId_pickupDay_pickupNumber_key" ON "Order"("outletId", "pickupDay", "pickupNumber");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_paymentAttemptId_key" ON "WalletTransaction"("paymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_reversesTransactionId_key" ON "WalletTransaction"("reversesTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key" ON "WalletTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletTransaction_walletId_createdAt_idx" ON "WalletTransaction"("walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_orderId_type_key" ON "WalletTransaction"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_providerReference_key" ON "PaymentAttempt"("providerReference");

-- CreateIndex
CREATE INDEX "PaymentAttempt_userId_createdAt_idx" ON "PaymentAttempt"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_userId_idempotencyKey_key" ON "PaymentAttempt"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletDailyCounter" ADD CONSTRAINT "OutletDailyCounter_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_reversesTransactionId_fkey" FOREIGN KEY ("reversesTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────
-- Wallet balances can never go negative, even if application code had a bug.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_non_negative" CHECK ("balancePaise" >= 0);
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_currency_inr" CHECK ("currency" = 'INR');

-- Ledger amounts are positive; direction carries the sign.
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_amount_positive" CHECK ("amountPaise" > 0);
-- A completed entry always records the resulting balance; a non-completed one never does.
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_completed_has_balance" CHECK (
  ("status" = 'COMPLETED') = ("balanceAfterPaise" IS NOT NULL AND "completedAt" IS NOT NULL)
);
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_balance_after_non_negative" CHECK ("balanceAfterPaise" IS NULL OR "balanceAfterPaise" >= 0);
-- Type and direction must agree.
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_type_direction" CHECK (
  ("type" IN ('RECHARGE', 'REFUND') AND "direction" = 'CREDIT')
  OR ("type" = 'ORDER_DEBIT' AND "direction" = 'DEBIT')
  OR ("type" = 'REVERSAL')
);

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_amount_positive" CHECK ("amountPaise" > 0);

-- Cart quantities 1–10.
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_quantity_range" CHECK ("quantity" BETWEEN 1 AND 10);

-- Order money is positive and internally consistent (no fees or taxes: decision Q7).
ALTER TABLE "Order" ADD CONSTRAINT "Order_totals_positive" CHECK ("subtotalPaise" > 0 AND "totalPaise" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_equals_subtotal" CHECK ("totalPaise" = "subtotalPaise");
ALTER TABLE "Order" ADD CONSTRAINT "Order_currency_inr" CHECK ("currency" = 'INR');
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_amounts_valid" CHECK (
  "quantity" BETWEEN 1 AND 10 AND "unitPricePaise" > 0 AND "lineTotalPaise" = "unitPricePaise" * "quantity"
);
-- Payment method and status must be compatible.
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_state_valid" CHECK (
  ("paymentMethod" = 'WALLET' AND "paymentStatus" IN ('PAID', 'REFUNDED'))
  OR ("paymentMethod" = 'COUNTER' AND "paymentStatus" IN ('PENDING_COUNTER', 'PAID', 'VOID'))
);
