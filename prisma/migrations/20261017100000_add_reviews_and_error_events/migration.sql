-- Avis après séjour : un seul avis par réservation, réponse de l'hôte.
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "hostReply" TEXT;
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "hostRepliedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "Review_bookingId_key" ON "Review"("bookingId");
CREATE INDEX IF NOT EXISTS "Review_createdAt_idx" ON "Review"("createdAt");

-- Surveillance : erreurs serveur regroupées par empreinte.
CREATE TABLE IF NOT EXISTS "ErrorEvent" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastUserId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ErrorEvent_fingerprint_key" ON "ErrorEvent"("fingerprint");
CREATE INDEX IF NOT EXISTS "ErrorEvent_resolvedAt_lastSeenAt_idx" ON "ErrorEvent"("resolvedAt", "lastSeenAt");
