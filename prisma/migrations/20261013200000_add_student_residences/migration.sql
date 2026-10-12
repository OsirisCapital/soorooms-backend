-- AlterEnum
ALTER TYPE "PropertyType" ADD VALUE 'STUDENT_RESIDENCE';

-- AlterTable
ALTER TABLE "Room" ADD COLUMN "semesterPrice" DECIMAL(10,2),
ADD COLUMN "yearPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "stayTerm" TEXT;
