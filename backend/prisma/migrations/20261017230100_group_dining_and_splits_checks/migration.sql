-- Separate from the previous migration: PostgreSQL can't use enum values (GROUP,
-- GROUP_SHARE_PAYMENT, PEER_TRANSFER_*) in the transaction that added them.

-- Group orders are paid in shares before they are placed; refunds go back share by share.
ALTER TABLE "Order" DROP CONSTRAINT "Order_payment_state_valid";
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_state_valid" CHECK (
  ("paymentMethod" = 'WALLET' AND "paymentStatus" IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'))
  OR ("paymentMethod" = 'COUNTER' AND "paymentStatus" IN ('PENDING_COUNTER', 'PAID', 'VOID'))
  OR ("paymentMethod" = 'GROUP' AND "paymentStatus" IN ('PAID', 'REFUNDED'))
);
-- Group orders are always "order now" and never use loyalty points.
ALTER TABLE "Order" ADD CONSTRAINT "Order_group_rules" CHECK (
  "paymentMethod" <> 'GROUP' OR ("timing" = 'IMMEDIATE' AND "pointsRedeemed" = 0)
);

-- Type and direction must agree, now including group shares and peer transfers.
ALTER TABLE "WalletTransaction" DROP CONSTRAINT "WalletTransaction_type_direction";
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_type_direction" CHECK (
  ("type" IN ('RECHARGE', 'REFUND', 'PEER_TRANSFER_IN') AND "direction" = 'CREDIT')
  OR ("type" IN ('ORDER_DEBIT', 'GROUP_SHARE_PAYMENT', 'PEER_TRANSFER_OUT') AND "direction" = 'DEBIT')
  OR ("type" = 'REVERSAL')
);
