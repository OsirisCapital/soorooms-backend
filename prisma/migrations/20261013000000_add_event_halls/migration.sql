-- AlterEnum
ALTER TYPE "PropertyType" ADD VALUE 'EVENT_HALL';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "eventType" TEXT,
ADD COLUMN "eventSlot" TEXT,
ADD COLUMN "eventGuests" INTEGER,
ADD COLUMN "eventOptions" JSONB;

-- CreateTable
CREATE TABLE "HallOption" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HallOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HallOption_propertyId_idx" ON "HallOption"("propertyId");

-- AddForeignKey
ALTER TABLE "HallOption" ADD CONSTRAINT "HallOption_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
