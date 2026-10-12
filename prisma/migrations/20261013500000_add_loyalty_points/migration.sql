-- Points de fidélité : registre en ajouts uniquement.
CREATE TABLE "LoyaltyEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "bookingId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoyaltyEntry_bookingId_reason_key" ON "LoyaltyEntry"("bookingId", "reason");
CREATE INDEX "LoyaltyEntry_userId_createdAt_idx" ON "LoyaltyEntry"("userId", "createdAt");

ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
