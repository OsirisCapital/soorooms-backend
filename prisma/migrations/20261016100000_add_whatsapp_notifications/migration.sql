-- Notifications WhatsApp : réglage par personne et rappel d'arrivée envoyé une seule fois par réservation.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "whatsappNotifications" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "arrivalReminderSentAt" TIMESTAMP(3);
