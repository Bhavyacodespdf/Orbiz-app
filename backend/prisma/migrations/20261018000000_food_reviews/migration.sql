-- CreateEnum
CREATE TYPE "FoodReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "FeedbackLevel" AS ENUM ('POOR', 'OKAY', 'GREAT');

-- CreateEnum
CREATE TYPE "FoodReviewReportReason" AS ENUM ('OFFENSIVE', 'SPAM', 'NOT_ABOUT_FOOD', 'PERSONAL_INFO', 'OTHER');

-- CreateTable
CREATE TABLE "FoodReview" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "taste" "FeedbackLevel",
    "portion" "FeedbackLevel",
    "freshness" "FeedbackLevel",
    "value" "FeedbackLevel",
    "verifiedPurchase" BOOLEAN NOT NULL DEFAULT true,
    "status" "FoodReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
    "moderatedById" UUID,
    "moderatedAt" TIMESTAMP(3),
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodReviewReport" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" "FoodReviewReportReason" NOT NULL,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodReviewReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FoodReview_menuItemId_status_createdAt_idx" ON "FoodReview"("menuItemId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FoodReview_outletId_status_createdAt_idx" ON "FoodReview"("outletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FoodReview_userId_updatedAt_idx" ON "FoodReview"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FoodReview_userId_menuItemId_key" ON "FoodReview"("userId", "menuItemId");

-- CreateIndex
CREATE INDEX "FoodReviewReport_reviewId_resolvedAt_idx" ON "FoodReviewReport"("reviewId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FoodReviewReport_reviewId_userId_key" ON "FoodReviewReport"("reviewId", "userId");

-- AddForeignKey
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodReviewReport" ADD CONSTRAINT "FoodReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "FoodReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FoodReviewReport" ADD CONSTRAINT "FoodReviewReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Ratings are whole stars; reviews and notes have a length limit; a hidden review records who hid it.
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_body_length" CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 1000);
ALTER TABLE "FoodReview" ADD CONSTRAINT "FoodReview_moderation_recorded" CHECK (
  "status" = 'PUBLISHED' OR ("moderatedById" IS NOT NULL AND "moderatedAt" IS NOT NULL)
);
ALTER TABLE "FoodReviewReport" ADD CONSTRAINT "FoodReviewReport_note_length" CHECK ("note" IS NULL OR char_length("note") <= 300);
