ALTER TABLE "Booking" ADD COLUMN "invoiceCompany" TEXT,
ADD COLUMN "invoiceAddress" TEXT,
ADD COLUMN "invoiceTaxId" TEXT,
ADD COLUMN "invoiceIssuedAt" TIMESTAMP(3);
