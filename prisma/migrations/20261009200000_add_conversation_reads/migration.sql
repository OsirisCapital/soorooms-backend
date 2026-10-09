-- CreateTable
CREATE TABLE "ConversationRead" (
    "userId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationRead_pkey" PRIMARY KEY ("userId","bookingId")
);

-- CreateIndex
CREATE INDEX "ConversationRead_bookingId_idx" ON "ConversationRead"("bookingId");

-- CreateIndex
CREATE INDEX "Message_bookingId_sentAt_idx" ON "Message"("bookingId", "sentAt");

-- AddForeignKey
ALTER TABLE "ConversationRead" ADD CONSTRAINT "ConversationRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationRead" ADD CONSTRAINT "ConversationRead_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
