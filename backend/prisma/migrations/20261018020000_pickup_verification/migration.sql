-- CreateEnum
CREATE TYPE "PickupCredentialStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PickupMethod" AS ENUM ('QR', 'CODE');

-- CreateEnum
CREATE TYPE "PickupAttemptOutcome" AS ENUM ('VERIFIED', 'NO_MATCH', 'EXPIRED', 'ALREADY_COLLECTED', 'LOCKED');

-- CreateTable
CREATE TABLE "PickupCredential" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "status" "PickupCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupVerification" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "method" "PickupMethod" NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderHandover" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "method" "PickupMethod" NOT NULL,
    "handedOverAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderHandover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupVerificationAttempt" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "staffUserId" UUID NOT NULL,
    "method" "PickupMethod" NOT NULL,
    "outcome" "PickupAttemptOutcome" NOT NULL,
    "credentialId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupVerificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PickupCredential_tokenHash_key" ON "PickupCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "PickupCredential_orderId_status_idx" ON "PickupCredential"("orderId", "status");

-- CreateIndex
CREATE INDEX "PickupCredential_outletId_codeHash_idx" ON "PickupCredential"("outletId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "PickupVerification_challengeHash_key" ON "PickupVerification"("challengeHash");

-- CreateIndex
CREATE INDEX "PickupVerification_credentialId_idx" ON "PickupVerification"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderHandover_orderId_key" ON "OrderHandover"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderHandover_credentialId_key" ON "OrderHandover"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderHandover_verificationId_key" ON "OrderHandover"("verificationId");

-- CreateIndex
CREATE INDEX "OrderHandover_outletId_handedOverAt_idx" ON "OrderHandover"("outletId", "handedOverAt");

-- CreateIndex
CREATE INDEX "PickupVerificationAttempt_staffUserId_outletId_createdAt_idx" ON "PickupVerificationAttempt"("staffUserId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "PickupVerificationAttempt_outletId_createdAt_idx" ON "PickupVerificationAttempt"("outletId", "createdAt");

-- AddForeignKey
ALTER TABLE "PickupCredential" ADD CONSTRAINT "PickupCredential_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupCredential" ADD CONSTRAINT "PickupCredential_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupCredential" ADD CONSTRAINT "PickupCredential_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupVerification" ADD CONSTRAINT "PickupVerification_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "PickupCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupVerification" ADD CONSTRAINT "PickupVerification_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupVerification" ADD CONSTRAINT "PickupVerification_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "PickupCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "PickupVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupVerificationAttempt" ADD CONSTRAINT "PickupVerificationAttempt_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupVerificationAttempt" ADD CONSTRAINT "PickupVerificationAttempt_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one usable credential per order, and an active numeric code is unambiguous per outlet.
CREATE UNIQUE INDEX "PickupCredential_one_active_per_order" ON "PickupCredential"("orderId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "PickupCredential_active_code_per_outlet" ON "PickupCredential"("outletId", "codeHash") WHERE "status" = 'ACTIVE';

-- States must record what happened.
ALTER TABLE "PickupCredential" ADD CONSTRAINT "PickupCredential_state_recorded" CHECK (
  ("status" <> 'REDEEMED' OR ("redeemedAt" IS NOT NULL AND "redeemedById" IS NOT NULL))
  AND ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL)
);
ALTER TABLE "PickupCredential" ADD CONSTRAINT "PickupCredential_expiry_after_issue" CHECK ("expiresAt" > "createdAt");

-- Handover records are immutable: never updated or deleted.
CREATE FUNCTION "order_handover_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OrderHandover records cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrderHandover_no_update_delete"
  BEFORE UPDATE OR DELETE ON "OrderHandover"
  FOR EACH ROW EXECUTE FUNCTION "order_handover_immutable"();
