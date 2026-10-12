-- Lien de paiement pour un proche (diaspora) : jeton secret, unique, nullable.
ALTER TABLE "Booking" ADD COLUMN "payToken" TEXT;
CREATE UNIQUE INDEX "Booking_payToken_key" ON "Booking"("payToken");
