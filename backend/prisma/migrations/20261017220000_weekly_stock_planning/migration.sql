-- CreateEnum
CREATE TYPE "ForecastConfidence" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "StockPlanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'COMPLETED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PlanAction" AS ENUM ('NONE', 'SMALL', 'MEDIUM', 'LARGE');

-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('PENDING', 'FINALIZED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('REJECTED', 'VALIDATED', 'ACTIVE', 'RETIRED');

-- AlterTable
ALTER TABLE "StockAdjustment" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "planItemId" UUID;

-- CreateTable
CREATE TABLE "DemandDaily" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "weekday" INTEGER NOT NULL,
    "unitsOrdered" INTEGER NOT NULL,
    "unitsCancelled" INTEGER NOT NULL,
    "unitsRejected" INTEGER NOT NULL,
    "unitsFulfilled" INTEGER NOT NULL,
    "unitsNoShow" INTEGER NOT NULL,
    "unitsOpen" INTEGER NOT NULL,
    "unitsScheduled" INTEGER NOT NULL,
    "unitsImmediate" INTEGER NOT NULL,
    "demandValuePaise" INTEGER NOT NULL,
    "unitsDeducted" INTEGER NOT NULL,
    "unitsRestored" INTEGER NOT NULL,
    "unitsReplenished" INTEGER NOT NULL,
    "unitsWasted" INTEGER NOT NULL,
    "openingStock" INTEGER,
    "closingStock" INTEGER,
    "stockoutMinutes" INTEGER NOT NULL,
    "censored" BOOLEAN NOT NULL,
    "outletActive" BOOLEAN NOT NULL,
    "categoryId" UUID NOT NULL,
    "fulfillmentType" "FoodFulfillment",
    "source" TEXT NOT NULL DEFAULT 'ORDERS_AND_STOCK_LEDGER',
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastRun" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "asOfDate" DATE NOT NULL,
    "historyFrom" DATE NOT NULL,
    "historyTo" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "createdByUserId" UUID,
    "evaluation" JSONB,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Forecast" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "targetDate" DATE NOT NULL,
    "horizonDays" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "lower" DOUBLE PRECISION NOT NULL,
    "upper" DOUBLE PRECISION NOT NULL,
    "confidence" "ForecastConfidence" NOT NULL,
    "features" JSONB NOT NULL,
    "actualDemand" INTEGER,
    "actualCensored" BOOLEAN,
    "absError" DOUBLE PRECISION,
    "evaluatedAt" TIMESTAMP(3),

    CONSTRAINT "Forecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPlan" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "StockPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "forecastRunId" UUID NOT NULL,
    "policyName" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "totalForecastUnits" DOUBLE PRECISION NOT NULL,
    "totalRecommendedUnits" INTEGER NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdByUserId" UUID,
    "submittedByUserId" UUID,
    "submittedAt" TIMESTAMP(3),
    "approvedByUserId" UUID,
    "approvedAt" TIMESTAMP(3),
    "completedByUserId" UUID,
    "completedAt" TIMESTAMP(3),
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPlanItem" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "dailyForecast" JSONB NOT NULL,
    "forecastUnits" DOUBLE PRECISION NOT NULL,
    "confidence" "ForecastConfidence" NOT NULL,
    "tracked" BOOLEAN NOT NULL,
    "currentStock" INTEGER,
    "expectedIncoming" INTEGER NOT NULL DEFAULT 0,
    "safetyStock" INTEGER NOT NULL,
    "targetStock" INTEGER NOT NULL,
    "action" "PlanAction" NOT NULL,
    "recommendedQty" INTEGER NOT NULL,
    "finalQty" INTEGER NOT NULL,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "explanation" JSONB NOT NULL,
    "replenishedQty" INTEGER NOT NULL DEFAULT 0,
    "outcome" JSONB,

    CONSTRAINT "StockPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPlanRevision" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "planItemId" UUID,
    "kind" TEXT NOT NULL,
    "fromQty" INTEGER,
    "toQty" INTEGER,
    "fromStatus" "StockPlanStatus",
    "toStatus" "StockPlanStatus",
    "reason" TEXT,
    "actorUserId" UUID,
    "actorRole" "Role",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockPlanRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningDecision" (
    "id" UUID NOT NULL,
    "planItemId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "menuItemId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "policyName" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "candidateActions" JSONB NOT NULL,
    "action" "PlanAction" NOT NULL,
    "recommendedQty" INTEGER NOT NULL,
    "approvedQty" INTEGER NOT NULL,
    "replenishedQty" INTEGER,
    "demandUnits" INTEGER,
    "fulfilledUnits" INTEGER,
    "stockoutDays" INTEGER,
    "estimatedLostUnits" INTEGER,
    "wastedUnits" INTEGER,
    "leftoverUnits" INTEGER,
    "censored" BOOLEAN,
    "rewardComponents" JSONB,
    "reward" DOUBLE PRECISION,
    "status" "DecisionStatus" NOT NULL DEFAULT 'PENDING',
    "excludeReason" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanningDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "PolicyStatus" NOT NULL,
    "algorithm" TEXT NOT NULL,
    "artifact" JSONB NOT NULL,
    "rewardConfig" JSONB NOT NULL,
    "dataset" JSONB NOT NULL,
    "evaluation" JSONB NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningJobRun" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "details" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PlanningJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemandDaily_outletId_businessDate_idx" ON "DemandDaily"("outletId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "DemandDaily_outletId_menuItemId_businessDate_key" ON "DemandDaily"("outletId", "menuItemId", "businessDate");

-- CreateIndex
CREATE INDEX "ForecastRun_outletId_weekStart_createdAt_idx" ON "ForecastRun"("outletId", "weekStart", "createdAt");

-- CreateIndex
CREATE INDEX "Forecast_outletId_targetDate_idx" ON "Forecast"("outletId", "targetDate");

-- CreateIndex
CREATE UNIQUE INDEX "Forecast_runId_menuItemId_targetDate_key" ON "Forecast"("runId", "menuItemId", "targetDate");

-- CreateIndex
CREATE INDEX "StockPlan_outletId_weekStart_status_idx" ON "StockPlan"("outletId", "weekStart", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockPlan_outletId_weekStart_version_key" ON "StockPlan"("outletId", "weekStart", "version");

-- CreateIndex
CREATE UNIQUE INDEX "StockPlanItem_planId_menuItemId_key" ON "StockPlanItem"("planId", "menuItemId");

-- CreateIndex
CREATE INDEX "StockPlanRevision_planId_createdAt_idx" ON "StockPlanRevision"("planId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanningDecision_planItemId_key" ON "PlanningDecision"("planItemId");

-- CreateIndex
CREATE INDEX "PlanningDecision_policyName_policyVersion_periodStart_idx" ON "PlanningDecision"("policyName", "policyVersion", "periodStart");

-- CreateIndex
CREATE INDEX "PlanningDecision_status_periodEnd_idx" ON "PlanningDecision"("status", "periodEnd");

-- CreateIndex
CREATE INDEX "PolicyVersion_name_status_idx" ON "PolicyVersion"("name", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_name_version_key" ON "PolicyVersion"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PlanningJobRun_job_key_key" ON "PlanningJobRun"("job", "key");

-- CreateIndex
CREATE UNIQUE INDEX "StockAdjustment_idempotencyKey_key" ON "StockAdjustment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockAdjustment_planItemId_idx" ON "StockAdjustment"("planItemId");

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "StockPlanItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandDaily" ADD CONSTRAINT "DemandDaily_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandDaily" ADD CONSTRAINT "DemandDaily_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastRun" ADD CONSTRAINT "ForecastRun_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastRun" ADD CONSTRAINT "ForecastRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ForecastRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_forecastRunId_fkey" FOREIGN KEY ("forecastRunId") REFERENCES "ForecastRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlanItem" ADD CONSTRAINT "StockPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "StockPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlanItem" ADD CONSTRAINT "StockPlanItem_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlanRevision" ADD CONSTRAINT "StockPlanRevision_planId_fkey" FOREIGN KEY ("planId") REFERENCES "StockPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlanRevision" ADD CONSTRAINT "StockPlanRevision_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "StockPlanItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPlanRevision" ADD CONSTRAINT "StockPlanRevision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningDecision" ADD CONSTRAINT "PlanningDecision_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "StockPlanItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningDecision" ADD CONSTRAINT "PlanningDecision_menuItemId_outletId_fkey" FOREIGN KEY ("menuItemId", "outletId") REFERENCES "MenuItem"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity rules the schema language can't express.
ALTER TABLE "DemandDaily" ADD CONSTRAINT "DemandDaily_counts_valid" CHECK (
  "weekday" BETWEEN 0 AND 6
  AND "unitsOrdered" >= 0 AND "unitsCancelled" >= 0 AND "unitsRejected" >= 0
  AND "unitsFulfilled" >= 0 AND "unitsNoShow" >= 0 AND "unitsOpen" >= 0
  AND "unitsCancelled" + "unitsRejected" + "unitsFulfilled" + "unitsNoShow" + "unitsOpen" = "unitsOrdered"
  AND "unitsScheduled" + "unitsImmediate" = "unitsOrdered"
  AND "demandValuePaise" >= 0 AND "unitsDeducted" >= 0 AND "unitsRestored" >= 0
  AND "unitsReplenished" >= 0 AND "unitsWasted" >= 0
  AND ("openingStock" IS NULL OR "openingStock" >= 0)
  AND ("closingStock" IS NULL OR "closingStock" >= 0)
  AND "stockoutMinutes" BETWEEN 0 AND 1440
  AND "censored" = ("stockoutMinutes" > 0)
);

ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_values_valid" CHECK (
  "quantity" >= 0 AND "lower" >= 0 AND "lower" <= "quantity" AND "quantity" <= "upper"
  AND "horizonDays" >= 0
  AND ("actualDemand" IS NULL OR "actualDemand" >= 0)
  AND ("absError" IS NULL OR "absError" >= 0)
);

ALTER TABLE "StockPlan" ADD CONSTRAINT "StockPlan_week_valid" CHECK (
  "weekEnd" = "weekStart" + 6 AND EXTRACT(ISODOW FROM "weekStart") = 1
  AND "version" >= 1 AND "totalForecastUnits" >= 0 AND "totalRecommendedUnits" >= 0
);

-- One live plan per outlet and week; older versions stay as SUPERSEDED history.
CREATE UNIQUE INDEX "StockPlan_one_live_per_week" ON "StockPlan" ("outletId", "weekStart")
  WHERE "status" <> 'SUPERSEDED';

ALTER TABLE "StockPlanItem" ADD CONSTRAINT "StockPlanItem_quantities_valid" CHECK (
  "forecastUnits" >= 0 AND "safetyStock" >= 0 AND "targetStock" >= 0
  AND "expectedIncoming" >= 0 AND "recommendedQty" >= 0 AND "finalQty" >= 0
  AND "replenishedQty" >= 0 AND "finalQty" <= 100000 AND "recommendedQty" <= 100000
  AND ("currentStock" IS NULL OR "currentStock" >= 0)
  AND ("tracked" OR "currentStock" IS NULL)
  AND ("overridden" = ("overrideReason" IS NOT NULL))
);

ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_plan_link_valid" CHECK (
  "planItemId" IS NULL OR ("type" = 'RESTOCK' AND "idempotencyKey" IS NOT NULL)
);

ALTER TABLE "PlanningDecision" ADD CONSTRAINT "PlanningDecision_values_valid" CHECK (
  "recommendedQty" >= 0 AND "approvedQty" >= 0
  AND ("replenishedQty" IS NULL OR "replenishedQty" >= 0)
  AND ("demandUnits" IS NULL OR "demandUnits" >= 0)
  AND ("fulfilledUnits" IS NULL OR "fulfilledUnits" >= 0)
  AND ("wastedUnits" IS NULL OR "wastedUnits" >= 0)
  AND ("leftoverUnits" IS NULL OR "leftoverUnits" >= 0)
  AND ("status" <> 'FINALIZED' OR ("reward" IS NOT NULL AND "finalizedAt" IS NOT NULL))
  AND ("status" <> 'EXCLUDED' OR "excludeReason" IS NOT NULL)
);

-- At most one active learned policy per name.
CREATE UNIQUE INDEX "PolicyVersion_one_active" ON "PolicyVersion" ("name") WHERE "status" = 'ACTIVE';
