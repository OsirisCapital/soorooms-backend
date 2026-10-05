/**
 * Données de test SòôRooms — à lancer UNE fois sur une base de développement :
 *
 *     node prisma/seed.mjs
 *
 * Crée un hôte de test (KYC approuvé) et quelques logements ACTIFS avec leurs
 * chambres, équipements et gestionnaire. Relançable sans doublons : l'hôte est
 * retrouvé par son téléphone et chaque logement par son titre.
 *
 * Écrit en SQL direct avec `pg` (déjà installé) pour ne dépendre ni de tsx ni
 * du client Prisma généré en TypeScript. Utilise DATABASE_URL du fichier .env.
 *
 * Compte hôte de test : +237600000001 / Seed1234!
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import pg from 'pg';

const HOST_PHONE = '+237600000001';
const HOST_PASSWORD = 'Seed1234!';

const PROPERTIES = [
  {
    title: 'Villa Bord de Mer',
    description: 'Grande villa à deux étages, jardin et allée privée, à quelques minutes de la plage.',
    propertyType: 'GUEST_HOUSE',
    city: 'Kribi',
    quarter: 'Talla',
    lat: 2.9373,
    lng: 9.9075,
    amenities: { wifi: true, power: true, ac: true, parking: true, extra: ['Jardin', 'Cuisine équipée'] },
    rooms: [{ name: 'Villa entière', type: 'Maison entière', price: 65000, guests: 8, beds: 5, bedrooms: 4 }],
  },
  {
    title: 'Villa Les Palmiers',
    description: 'Villa blanche avec balcons, parking et espace extérieur. Idéale pour un séjour en famille.',
    propertyType: 'GUEST_HOUSE',
    city: 'Kribi',
    quarter: 'Mpalla',
    lat: 2.9402,
    lng: 9.9127,
    amenities: { wifi: true, power: false, ac: true, parking: true, extra: ['Balcon'] },
    rooms: [{ name: 'Villa entière', type: 'Maison entière', price: 65000, guests: 6, beds: 4, bedrooms: 3 }],
  },
  {
    title: 'Résidence des Collines',
    description: 'Maison traditionnelle rénovée, vue dégagée et grand jardin.',
    propertyType: 'GUEST_HOUSE',
    city: 'Bafoussam',
    quarter: 'Tamdja',
    lat: 5.4737,
    lng: 10.4179,
    amenities: { wifi: true, power: true, ac: false, parking: true, extra: ['Jardin'] },
    rooms: [{ name: 'Maison entière', type: 'Maison entière', price: 75000, guests: 6, beds: 4, bedrooms: 3 }],
  },
  {
    title: 'City Apartments Bonanjo',
    description: 'Appartements meublés en centre-ville, piscine commune et sécurité 24h/24.',
    propertyType: 'FURNISHED_APARTMENT',
    city: 'Douala',
    quarter: 'Bonanjo',
    lat: 4.0511,
    lng: 9.6934,
    amenities: { wifi: true, power: true, ac: true, parking: true, extra: ['Piscine', 'Sécurité 24h/24'] },
    rooms: [
      { name: 'Studio', type: 'Studio', price: 45000, guests: 2, beds: 1, bedrooms: 1 },
      { name: 'Appartement 2 chambres', type: 'Appartement', price: 75000, guests: 4, beds: 2, bedrooms: 2 },
    ],
  },
  {
    title: 'Hôtel Le Wouri',
    description: 'Hôtel de ville avec petit-déjeuner, climatisation et groupe électrogène.',
    propertyType: 'HOTEL',
    city: 'Douala',
    quarter: 'Akwa',
    lat: 4.0469,
    lng: 9.7014,
    amenities: { wifi: true, power: true, ac: true, parking: true, extra: ['Petit-déjeuner inclus'] },
    rooms: [
      { name: 'Chambre standard', type: 'Chambre', price: 30000, guests: 2, beds: 1, bedrooms: 1 },
      { name: 'Chambre familiale', type: 'Chambre', price: 50000, guests: 4, beds: 2, bedrooms: 1 },
    ],
  },
  {
    title: 'Appartement Bastos',
    description: 'Appartement lumineux dans un quartier calme et résidentiel de Yaoundé.',
    propertyType: 'FURNISHED_APARTMENT',
    city: 'Yaoundé',
    quarter: 'Bastos',
    lat: 3.8960,
    lng: 11.5167,
    amenities: { wifi: true, power: true, ac: true, parking: true, extra: [] },
    rooms: [{ name: 'Appartement 3 pièces', type: 'Appartement', price: 55000, guests: 4, beds: 2, bedrooms: 2 }],
  },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');

  const passwordHash = await bcrypt.hash(HOST_PASSWORD, 10);
  const existingUser = await client.query('SELECT id FROM "User" WHERE phone = $1', [HOST_PHONE]);
  let hostId = existingUser.rows[0]?.id;

  if (!hostId) {
    hostId = randomUUID();
    await client.query(
      `INSERT INTO "User" (id, "fullName", phone, "passwordHash", role, "kycStatus", "updatedAt")
       VALUES ($1, $2, $3, $4, 'HOST', 'APPROVED', NOW())`,
      [hostId, 'Hôte de test', HOST_PHONE, passwordHash],
    );
    await client.query(
      `INSERT INTO "HostProfile" (id, "userId", bio, "updatedAt") VALUES ($1, $2, $3, NOW())`,
      [randomUUID(), hostId, 'Compte de démonstration.'],
    );
    console.log(`Hôte créé : ${HOST_PHONE} / ${HOST_PASSWORD}`);
  } else {
    console.log(`Hôte déjà présent : ${HOST_PHONE}`);
  }

  for (const p of PROPERTIES) {
    const exists = await client.query('SELECT 1 FROM "Property" WHERE title = $1 AND city = $2', [p.title, p.city]);
    if (exists.rowCount > 0) {
      console.log(`= ${p.title} (${p.city}) existe déjà`);
      continue;
    }

    const propertyId = randomUUID();
    await client.query(
      `INSERT INTO "Property"
         (id, title, description, "propertyType", city, quarter, region, country, latitude, longitude, status, "updatedAt")
       VALUES ($1, $2, $3, $4::"PropertyType", $5, $6, NULL, 'Cameroun', $7, $8, 'ACTIVE', NOW())`,
      [propertyId, p.title, p.description, p.propertyType, p.city, p.quarter, p.lat, p.lng],
    );
    await client.query(
      `INSERT INTO "PropertyAmenity"
         (id, "propertyId", "hasWifi", "hasGeneratorOrSolar", "hasAc", "hasParking", "additionalEquipments")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), propertyId, p.amenities.wifi, p.amenities.power, p.amenities.ac, p.amenities.parking, p.amenities.extra],
    );
    await client.query(
      `INSERT INTO "PropertyCollaborator" (id, "userId", "propertyId", role) VALUES ($1, $2, $3, 'MANAGER')`,
      [randomUUID(), hostId, propertyId],
    );
    for (const r of p.rooms) {
      await client.query(
        `INSERT INTO "Room"
           (id, "propertyId", name, "roomType", "basePrice", "maxGuests", "bedCount", "bedroomCount", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [randomUUID(), propertyId, r.name, r.type, r.price, r.guests, r.beds, r.bedrooms],
      );
    }
    console.log(`+ ${p.title} (${p.city}) — ${p.rooms.length} chambre(s)`);
  }

  await client.query('COMMIT');
  console.log('Seed terminé.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Seed annulé :', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
