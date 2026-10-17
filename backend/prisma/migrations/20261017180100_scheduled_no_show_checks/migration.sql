-- Separate from the previous migration: PostgreSQL can't use enum values (NO_SHOW,
-- PARTIALLY_REFUNDED) in the same transaction that added them.
-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────

-- Wallet orders may now be partly refunded (no-show policy); counter orders unchanged.
ALTER TABLE "Order" DROP CONSTRAINT "Order_payment_state_valid";
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_state_valid" CHECK (
  ("paymentMethod" = 'WALLET' AND "paymentStatus" IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'))
  OR ("paymentMethod" = 'COUNTER' AND "paymentStatus" IN ('PENDING_COUNTER', 'PAID', 'VOID'))
);
-- Only scheduled orders can be no-shows.
ALTER TABLE "Order" ADD CONSTRAINT "Order_no_show_is_scheduled"
  CHECK ("status" <> 'NO_SHOW' OR "timing" = 'SCHEDULED');

-- Per-line outcome: refund + fee = paid, never negative, restock never above the quantity.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_no_show_amounts_valid" CHECK (
  ("noShowPaidPaise" IS NULL AND "noShowRefundPaise" IS NULL AND "noShowFeePaise" IS NULL)
  OR ("noShowPaidPaise" >= 0 AND "noShowRefundPaise" >= 0 AND "noShowFeePaise" >= 0
      AND "noShowRefundPaise" + "noShowFeePaise" = "noShowPaidPaise"
      AND "noShowPaidPaise" <= "lineTotalPaise")
);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_no_show_restock_valid"
  CHECK ("noShowRestockedQty" IS NULL OR "noShowRestockedQty" BETWEEN 0 AND "quantity");

ALTER TABLE "NoShowSettlement" ADD CONSTRAINT "NoShowSettlement_amounts_valid" CHECK (
  "refundPaise" >= 0 AND "convenienceFeePaise" >= 0 AND "scheduledFeeRetainedPaise" >= 0
  AND "restockedUnits" >= 0 AND "attempts" >= 0
);
