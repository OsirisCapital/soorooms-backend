-- Coordonnées de versement de l'hôte
ALTER TABLE "HostProfile" ADD COLUMN "payoutChannel" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "payoutPhone" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "payoutAccountName" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "payoutUpdatedAt" TIMESTAMP(3);

-- Versements aux hôtes (file de validation par la finance)
CREATE TYPE "PayoutStatus" AS ENUM ('TO_SEND', 'SENDING', 'PROCESSING', 'PAID', 'FAILED');

CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "hostUserId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'TO_SEND',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "gatewayRef" TEXT,
    "beneficiaryChannel" TEXT,
    "beneficiaryPhone" TEXT,
    "beneficiaryName" TEXT,
    "failureReason" TEXT,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payout_escrowId_key" ON "Payout"("escrowId");
CREATE UNIQUE INDEX "Payout_reference_key" ON "Payout"("reference");
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

ALTER TABLE "Payout" ADD CONSTRAINT "Payout_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "EscrowVault"("id") ON DELETE CASCADE ON UPDATE CASCADE;

