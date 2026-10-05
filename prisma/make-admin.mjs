/**
 * Passe un compte existant en ADMIN (accès à /admin : validation KYC, litiges).
 *
 *     node prisma/make-admin.mjs +237600000001
 *
 * Le compte doit déjà exister (inscription normale depuis l'application).
 * Il n'existe volontairement aucune route HTTP pour devenir admin.
 */
import 'dotenv/config';
import pg from 'pg';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage : node prisma/make-admin.mjs <téléphone>   (ex. +237600000001)');
  process.exit(1);
}

// Même normalisation que l'API (src/common/utils/phone.ts).
let phone = raw.replace(/[\s.\-()]/g, '');
if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
if (/^237\d{9}$/.test(phone)) phone = `+${phone}`;
if (/^[26]\d{8}$/.test(phone)) phone = `+237${phone}`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query(`UPDATE "User" SET role = 'ADMIN' WHERE phone = $1`, [phone]);
  console.log(rowCount ? `✔ ${phone} est maintenant ADMIN. Reconnectez-vous dans l'application.` : `✘ Aucun compte avec le numéro ${phone}.`);
} finally {
  await client.end();
}
