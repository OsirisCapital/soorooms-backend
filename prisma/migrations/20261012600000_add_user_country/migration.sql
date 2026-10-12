-- AlterTable
ALTER TABLE "User" ADD COLUMN "countryCode" TEXT;

-- Comptes existants : tous camerounais jusqu'ici.
UPDATE "User" SET "countryCode" = 'CM' WHERE "phone" LIKE '+237%';
