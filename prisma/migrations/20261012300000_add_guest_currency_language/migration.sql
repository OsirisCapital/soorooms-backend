-- Réserver pour quelqu'un d'autre : le payeur reste le compte connecté, l'occupant est décrit ici.
ALTER TABLE "Booking" ADD COLUMN "guestName" TEXT;
ALTER TABLE "Booking" ADD COLUMN "guestPhone" TEXT;

-- Devise de la réservation (XAF par défaut) et langue préférée de l'utilisateur.
ALTER TABLE "Booking" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'XAF';
ALTER TABLE "User" ADD COLUMN "preferredLanguage" TEXT NOT NULL DEFAULT 'fr';
