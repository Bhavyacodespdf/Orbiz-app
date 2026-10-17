-- Orders can now carry a loyalty-points discount, so "total = subtotal" no longer holds.
-- It is replaced by "Order_total_after_discount" (total = subtotal − points discount),
-- added in the previous migration, which is identical whenever no points are used.
ALTER TABLE "Order" DROP CONSTRAINT "Order_total_equals_subtotal";
