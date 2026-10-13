-- Auberges (nouveau type de logement).
ALTER TYPE "PropertyType" ADD VALUE IF NOT EXISTS 'HOSTEL';

-- Siestes (séjours de quelques heures) : réglages par chambre, équipements ajoutables.
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "allowsNap" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "napPrice" DECIMAL(10,2);
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "napHours" INTEGER;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "napBulb" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "equipments" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Réservation d'une sieste : heure de début et durée (null pour un séjour).
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "napStartHour" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "napHours" INTEGER;
