-- Réglages des commissions et frais, modifiables par le super administrateur.
-- Chaque modification ajoute une ligne : la dernière est en vigueur, les précédentes forment l'historique.
CREATE TABLE "PlatformFeeConfig" (
    "id" TEXT NOT NULL,
    "hostCommissionPercent" DECIMAL(5,2) NOT NULL,
    "launchHostCommissionPercent" DECIMAL(5,2),
    "launchEndsAt" TIMESTAMP(3),
    "travelerFeePercent" DECIMAL(5,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformFeeConfig_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformFeeConfig_createdAt_idx" ON "PlatformFeeConfig"("createdAt");

-- Valeurs de départ : commission 10 %, offre de lancement 5 % pendant 3 mois, frais voyageur 3 %.
-- La date de fin de l'offre se règle depuis la page « Frais » au vrai lancement.
INSERT INTO "PlatformFeeConfig" ("id", "hostCommissionPercent", "launchHostCommissionPercent", "launchEndsAt", "travelerFeePercent", "note")
VALUES ('initial-fees', 10, 5, CURRENT_TIMESTAMP + INTERVAL '3 months', 3, 'Valeurs de départ');

-- Taux appliqués à chaque réservation, figés au moment du paiement (les anciens séquestres restent à NULL).
ALTER TABLE "EscrowVault" ADD COLUMN "hostCommissionPercent" DECIMAL(5,2);
ALTER TABLE "EscrowVault" ADD COLUMN "travelerFeePercent" DECIMAL(5,2);
ALTER TABLE "EscrowVault" ADD COLUMN "travelerFee" DECIMAL(10,2) NOT NULL DEFAULT 0;
