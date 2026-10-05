# Mise en route après récupération de ce zip

1. `npm install`
2. Copiez `.env.example` vers `.env` et remplissez les valeurs (DB, secrets JWT, Google OAuth).
3. `npx prisma generate` — génère le client Prisma à partir de `prisma/schema.prisma`.
4. `npx prisma migrate dev --name init_auth_and_kyc` — crée les tables en base.
5. `npm run build` (ou `npx tsc --noEmit`) — vérifie que tout compile.
6. `npm run start:dev` — lance l'API en local (Swagger disponible sur `/api/docs`).

Le fichier `prisma.config.ts.v8-platform.bak` est la config Prisma Platform (v8)
mise de côté — sans objet tant qu'on reste sur le workflow classique
(`prisma generate` / `migrate dev`). À ignorer, ou à réactiver si vous décidez
un jour d'héberger sur Prisma Platform.
