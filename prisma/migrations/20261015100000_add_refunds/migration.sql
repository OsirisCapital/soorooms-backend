-- Annulation d'une réservation : traçabilité sur la réservation + file des remboursements.
ALTER TABLE "Booking" ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledById" TEXT,
ADD COLUMN "cancelReason" TEXT;

CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "travelerId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
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

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Refund_escrowId_key" ON "Refund"("escrowId");
CREATE UNIQUE INDEX "Refund_reference_key" ON "Refund"("reference");
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "EscrowVault"("id") ON DELETE CASCADE ON UPDATE CASCADE;
