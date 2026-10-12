-- Attestation de réservation signée par un gérant, vérifiable publiquement grâce à son code.
ALTER TABLE "Booking" ADD COLUMN "attestationCode" TEXT;
ALTER TABLE "Booking" ADD COLUMN "attestationSignedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "attestationSignedById" TEXT;
ALTER TABLE "Booking" ADD COLUMN "attestationSignerName" TEXT;
CREATE UNIQUE INDEX "Booking_attestationCode_key" ON "Booking"("attestationCode");
