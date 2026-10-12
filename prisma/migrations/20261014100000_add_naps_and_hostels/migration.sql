-- Auberges (nouveau type de logement).
ALTER TYPE "PropertyType" ADD VALUE 'HOSTEL';

-- Siestes (séjours de quelques heures) : réglages par chambre, équipements ajoutables.
ALTER TABLE "Room" ADD COLUMN "allowsNap" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Room" ADD COLUMN "napPrice" DECIMAL(10,2);
ALTER TABLE "Room" ADD COLUMN "napHours" INTEGER;
ALTER TABLE "Room" ADD COLUMN "napBulb" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Room" ADD COLUMN "equipments" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Réservation d'une sieste : heure de début et durée (null pour un séjour).
ALTER TABLE "Booking" ADD COLUMN "napStartHour" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "napHours" INTEGER;
