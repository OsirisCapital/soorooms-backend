-- L'attestation se fait sur demande : pays déclaré par le voyageur, refus motivé possible de l'hôte.
ALTER TABLE "Booking" ADD COLUMN "attestationRequestedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "attestationCountry" TEXT;
ALTER TABLE "Booking" ADD COLUMN "attestationDeclinedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "attestationDeclineReason" TEXT;
