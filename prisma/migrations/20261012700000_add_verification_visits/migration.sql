-- AlterEnum
ALTER TYPE "StaffRole" ADD VALUE 'FIELD_AGENT';

-- AlterEnum
ALTER TYPE "VerificationTaskStatus" ADD VALUE 'AWAITING_PAYMENT';
ALTER TYPE "VerificationTaskStatus" ADD VALUE 'ASSIGNED';

-- AlterTable
ALTER TABLE "VerificationTask"
  ADD COLUMN "requestedById" TEXT,
  ADD COLUMN "amount" DECIMAL(10,0),
  ADD COLUMN "paymentGatewayId" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "visitedAt" TIMESTAMP(3),
  ADD COLUMN "checklist" JSONB,
  ADD COLUMN "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "PlatformFeeConfig" ADD COLUMN "verificationVisitPrice" DECIMAL(10,0);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationTask_paymentGatewayId_key" ON "VerificationTask"("paymentGatewayId");
CREATE INDEX "VerificationTask_status_createdAt_idx" ON "VerificationTask"("status", "createdAt");
CREATE INDEX "VerificationTask_propertyId_idx" ON "VerificationTask"("propertyId");
CREATE INDEX "VerificationTask_agentId_status_idx" ON "VerificationTask"("agentId", "status");
