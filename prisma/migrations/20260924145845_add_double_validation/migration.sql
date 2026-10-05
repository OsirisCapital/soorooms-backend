-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "hostConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "travelerConfirmedAt" TIMESTAMP(3);
