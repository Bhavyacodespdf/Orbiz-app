-- CreateEnum
CREATE TYPE "OutletStatus" AS ENUM ('OPEN', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('MANAGER', 'POS');

-- CreateEnum
CREATE TYPE "Dietary" AS ENUM ('VEG', 'NON_VEG', 'EGG');

-- CreateTable
CREATE TABLE "Outlet" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "status" "OutletStatus" NOT NULL DEFAULT 'CLOSED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outlet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAssignment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "role" "StaffRole" NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "pricePaise" INTEGER NOT NULL,
    "dietary" "Dietary",
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_slug_key" ON "Outlet"("slug");

-- CreateIndex
CREATE INDEX "StaffAssignment_outletId_idx" ON "StaffAssignment"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAssignment_userId_outletId_role_key" ON "StaffAssignment"("userId", "outletId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCategory_outletId_name_key" ON "MenuCategory"("outletId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCategory_id_outletId_key" ON "MenuCategory"("id", "outletId");

-- CreateIndex
CREATE INDEX "MenuItem_outletId_isActive_idx" ON "MenuItem"("outletId", "isActive");

-- CreateIndex
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_outletId_name_key" ON "MenuItem"("outletId", "name");

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_outletId_fkey" FOREIGN KEY ("categoryId", "outletId") REFERENCES "MenuCategory"("id", "outletId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written integrity constraints (Prisma cannot express CHECK) ───────
-- Prices are integer paise and must be positive.
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_pricePaise_positive" CHECK ("pricePaise" > 0);
-- Names may not be blank.
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_name_not_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_name_not_blank" CHECK (length(btrim("name")) > 0);
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_name_not_blank" CHECK (length(btrim("name")) > 0);
-- Slugs are lower-case URL segments.
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
