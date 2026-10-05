/**
 * Point d'entrée unique pour tout ce qui vient du client Prisma généré.
 * Prisma 7 génère le client dans un dossier de sortie (src/generated/prisma/,
 * volontairement placé DANS src/ pour respecter la contrainte `rootDir` de
 * TypeScript — un dossier généré hors de src/ casse la compilation avec
 * l'erreur TS6059). Il n'est plus réexporté depuis le paquet @prisma/client,
 * donc tout import applicatif d'un type ou enum Prisma passe par CE fichier
 * plutôt que par un chemin relatif répété dans chaque module.
 */
export * from '../generated/prisma/client.js';
