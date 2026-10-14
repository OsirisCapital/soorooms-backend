-- Programme partenaire : parrainage d'hôtes et de voyageurs, commissions, retraits.
DO $$ BEGIN CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'SUSPENDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PartnerPayoutStatus" AS ENUM ('REQUESTED', 'SENDING', 'PAID', 'FAILED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PartnerConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hostRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "hostMonths" INTEGER NOT NULL DEFAULT 18,
    "travelerRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "travelerMonths" INTEGER NOT NULL DEFAULT 6,
    "capPercent" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "minPayout" INTEGER NOT NULL DEFAULT 5000,
    "withholdingPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "claimWindowDays" INTEGER NOT NULL DEFAULT 14,
    "termsVersion" TEXT NOT NULL DEFAULT '2026-10',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PartnerProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedReason" TEXT,
    "termsVersion" TEXT NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "payoutChannel" TEXT,
    "payoutPhone" TEXT,
    "payoutAccountName" TEXT,
    "payoutUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerProfile_userId_key" ON "PartnerProfile"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerProfile_code_key" ON "PartnerProfile"("code");

CREATE TABLE IF NOT EXISTS "PartnerReferral" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "hostStartedAt" TIMESTAMP(3),
    "hostEndsAt" TIMESTAMP(3),
    "travelerEndsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerReferral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerReferral_referredUserId_key" ON "PartnerReferral"("referredUserId");
CREATE INDEX IF NOT EXISTS "PartnerReferral_partnerId_createdAt_idx" ON "PartnerReferral"("partnerId", "createdAt");

CREATE TABLE IF NOT EXISTS "PartnerCommission" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "revenue" DECIMAL(10,2) NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerCommission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerCommission_referralId_bookingId_key" ON "PartnerCommission"("referralId", "bookingId");
CREATE INDEX IF NOT EXISTS "PartnerCommission_partnerId_createdAt_idx" ON "PartnerCommission"("partnerId", "createdAt");
CREATE INDEX IF NOT EXISTS "PartnerCommission_bookingId_idx" ON "PartnerCommission"("bookingId");

CREATE TABLE IF NOT EXISTS "PartnerPayout" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "gross" DECIMAL(10,2) NOT NULL,
    "withholding" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(10,2) NOT NULL,
    "status" "PartnerPayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "gatewayRef" TEXT,
    "channel" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "failureReason" TEXT,
    "decidedById" TEXT,
    "decidedNote" TEXT,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerPayout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerPayout_reference_key" ON "PartnerPayout"("reference");
CREATE INDEX IF NOT EXISTS "PartnerPayout_status_createdAt_idx" ON "PartnerPayout"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "PartnerPayout_partnerId_createdAt_idx" ON "PartnerPayout"("partnerId", "createdAt");

DO $$ BEGIN ALTER TABLE "PartnerProfile" ADD CONSTRAINT "PartnerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PartnerCommission" ADD CONSTRAINT "PartnerCommission_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PartnerCommission" ADD CONSTRAINT "PartnerCommission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "PartnerReferral"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PartnerPayout" ADD CONSTRAINT "PartnerPayout_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO "PartnerConfig" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING;
