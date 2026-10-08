-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPER_ADMIN', 'KYC_REVIEWER', 'SUPPORT', 'FINANCE', 'CONTENT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "staffPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "staffRole" "StaffRole";

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Les administrateurs existants deviennent super administrateurs : ils gardent tous leurs accès.
UPDATE "User" SET "staffRole" = 'SUPER_ADMIN' WHERE "role" = 'ADMIN' AND "staffRole" IS NULL;
