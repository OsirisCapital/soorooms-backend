-- Nombre d'unités identiques par type de chambre (un hôtel avec 20 chambres "Standard" = 1 type, 20 unités).
-- Les chambres existantes gardent 1 unité : rien ne change pour elles.
ALTER TABLE "Room" ADD COLUMN "unitCount" INTEGER NOT NULL DEFAULT 1;

-- Photos propres à chaque type de chambre (au moins une est exigée pour publier le logement).
CREATE TABLE "RoomPhoto" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomPhoto_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RoomPhoto_roomId_position_idx" ON "RoomPhoto"("roomId", "position");
ALTER TABLE "RoomPhoto" ADD CONSTRAINT "RoomPhoto_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
