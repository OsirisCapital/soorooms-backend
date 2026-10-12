-- Réservation de groupe : plusieurs unités (chambres) d'un même type en une seule demande.
ALTER TABLE "Booking" ADD COLUMN "units" INTEGER NOT NULL DEFAULT 1;
