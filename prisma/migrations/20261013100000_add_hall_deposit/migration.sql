-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'DEPOSIT_PAID';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "depositPercent" INTEGER,
ADD COLUMN "balanceDueAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EscrowVault" ADD COLUMN "depositAmount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'FULL';
