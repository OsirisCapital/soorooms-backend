/**
 * Règles Cloudinary partagées par l'envoi de fichiers, la validation des URL
 * reçues et la consultation des documents privés. Fonctions pures, sans
 * dépendance Nest : faciles à tester et à relire.
 *
 * Deux régimes de livraison :
 *  - `upload` : fichier public (photos de logements, destinées à être vues) ;
 *  - `authenticated` : fichier privé (pièces d'identité du KYC). Son lien
 *    direct ne fonctionne pas ; seul le backend peut en produire un lien
 *    temporaire, réservé à un administrateur.
 */
import { createHash } from 'node:crypto';

export type AssetPurpose = 'property_photo' | 'kyc_document';
export type DeliveryType = 'upload' | 'authenticated';

export const ASSET_RULES: Record<AssetPurpose, { folder: string; allowedFormats: string; deliveryType: DeliveryType }> = {
  property_photo: { folder: 'soorooms/properties', allowedFormats: 'jpg,jpeg,png,webp', deliveryType: 'upload' },
  kyc_document: { folder: 'soorooms/kyc', allowedFormats: 'jpg,jpeg,png,webp,pdf', deliveryType: 'authenticated' },
};

/** Durée de validité d'un lien de consultation d'un document privé. */
export const PRIVATE_LINK_TTL_SECONDS = 10 * 60;

/** Longueur maximale d'une URL acceptée : aucune URL Cloudinary légitime n'approche cette taille. */
const MAX_URL_LENGTH = 500;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Signature d'API Cloudinary : paramètres triés par nom, joints en
 * « nom=valeur&… », suivis du secret, puis SHA-1 en hexadécimal. Le fichier,
 * api_key, cloud_name et resource_type ne font pas partie de la signature.
 */
export function signParams(params: Record<string, string | number | undefined>, apiSecret: string): string {
  const toSign = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');
}

/**
 * Forme exacte d'une URL produite par Cloudinary pour NOTRE compte, dans NOTRE
 * dossier, pour l'usage demandé. Groupes capturés : 1 = identifiant public
 * (dossier compris), 2 = format.
 */
function assetPattern(purpose: AssetPurpose, cloudName: string): RegExp {
  const { folder, allowedFormats, deliveryType } = ASSET_RULES[purpose];
  const formats = allowedFormats.split(',').join('|');
  // Les fichiers privés peuvent porter une signature « s--xxxxxxxx-- » dans leur chemin.
  const signature = deliveryType === 'authenticated' ? '(?:s--[A-Za-z0-9_-]{8}--/)?' : '';
  return new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRegExp(cloudName)}/image/${deliveryType}/${signature}(?:v\\d+/)?` +
      `(${escapeRegExp(folder)}/[A-Za-z0-9_-]+)\\.(${formats})$`,
  );
}

/** Vrai seulement si l'URL désigne un fichier que NOTRE application a envoyé à Cloudinary pour cet usage. */
export function isOwnCloudinaryAsset(value: unknown, purpose: AssetPurpose, cloudName: string | undefined): boolean {
  if (typeof value !== 'string' || !cloudName || value.length > MAX_URL_LENGTH) return false;
  return assetPattern(purpose, cloudName).test(value);
}

/** Extrait l'identifiant public et le format d'un document KYC privé ; null pour toute autre URL. */
export function parsePrivateKycAsset(value: string, cloudName: string): { publicId: string; format: string } | null {
  if (value.length > MAX_URL_LENGTH) return null;
  const match = assetPattern('kyc_document', cloudName).exec(value);
  return match ? { publicId: match[1], format: match[2] } : null;
}

/**
 * Lien de téléchargement d'un fichier privé : signé avec le secret d'API et
 * limité dans le temps (`expires_at`). Même mécanisme que `private_download_url`
 * du SDK officiel de Cloudinary.
 */
export function buildPrivateDownloadUrl(input: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  publicId: string;
  format: string;
  /** Instant de création, en secondes Unix. */
  timestamp: number;
  /** Instant d'expiration du lien, en secondes Unix. */
  expiresAt: number;
}): string {
  const signed = {
    expires_at: input.expiresAt,
    format: input.format,
    public_id: input.publicId,
    timestamp: input.timestamp,
    type: 'authenticated',
  };
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(signed).map(([name, value]) => [name, String(value)])),
    api_key: input.apiKey,
    signature: signParams(signed, input.apiSecret),
  });
  return `https://api.cloudinary.com/v1_1/${input.cloudName}/image/download?${query.toString()}`;
}
