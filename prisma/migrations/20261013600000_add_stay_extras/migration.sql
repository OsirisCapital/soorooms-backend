-- Services partenaires / extras payants pour tous les logements (navette, petit-déjeuner…).
ALTER TABLE "HallOption" ADD COLUMN "perNight" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Booking" ADD COLUMN "extras" JSONB;
