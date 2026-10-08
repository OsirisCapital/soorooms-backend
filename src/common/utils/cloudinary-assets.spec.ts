import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPrivateDownloadUrl,
  isOwnCloudinaryAsset,
  parsePrivateKycAsset,
  signParams,
} from './cloudinary-assets.js';

const CLOUD = 'demo-cloud';
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

describe('isOwnCloudinaryAsset — photos de logements (livraison publique)', () => {
  const photo = `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/soorooms/properties/abc123_XYZ-9.jpg`;

  it('accepte une photo envoyée par notre application, avec ou sans numéro de version', () => {
    expect(isOwnCloudinaryAsset(photo, 'property_photo', CLOUD)).toBe(true);
    expect(isOwnCloudinaryAsset(photo.replace('v1700000000/', ''), 'property_photo', CLOUD)).toBe(true);
  });

  it.each(['jpg', 'jpeg', 'png', 'webp'])('accepte le format %s', (ext) => {
    expect(isOwnCloudinaryAsset(photo.replace('.jpg', `.${ext}`), 'property_photo', CLOUD)).toBe(true);
  });

  it('refuse un site extérieur, même avec une apparence de lien Cloudinary', () => {
    expect(isOwnCloudinaryAsset('https://example.com/photo.jpg', 'property_photo', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset(photo.replace('res.cloudinary.com', 'res.cloudinary.com.evil.test'), 'property_photo', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset(`https://evil.test/res.cloudinary.com/${CLOUD}/image/upload/soorooms/properties/a.jpg`, 'property_photo', CLOUD)).toBe(false);
  });

  it("refuse le compte Cloudinary de quelqu'un d'autre", () => {
    expect(isOwnCloudinaryAsset(photo.replace(CLOUD, 'autre-compte'), 'property_photo', CLOUD)).toBe(false);
  });

  it('refuse http (non chiffré)', () => {
    expect(isOwnCloudinaryAsset(photo.replace('https://', 'http://'), 'property_photo', CLOUD)).toBe(false);
  });

  it("refuse l'ancien dossier mal orthographié et tout autre dossier", () => {
    expect(isOwnCloudinaryAsset(photo.replace('soorooms/', 'sooroms/'), 'property_photo', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset(photo.replace('soorooms/properties', 'autre/dossier'), 'property_photo', CLOUD)).toBe(false);
  });

  it("refuse un fichier du dossier KYC présenté comme photo, et les remontées de dossier", () => {
    expect(isOwnCloudinaryAsset(photo.replace('properties', 'kyc'), 'property_photo', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset(photo.replace('properties/abc123_XYZ-9', 'properties/../kyc/secret'), 'property_photo', CLOUD)).toBe(false);
  });

  it("refuse les formats qui ne sont pas des photos (pdf, svg, html) et les majuscules", () => {
    for (const ext of ['pdf', 'svg', 'html', 'gif', 'JPG']) {
      expect(isOwnCloudinaryAsset(photo.replace('.jpg', `.${ext}`), 'property_photo', CLOUD)).toBe(false);
    }
  });

  it('refuse un paramètre ou un fragment ajouté à la fin', () => {
    expect(isOwnCloudinaryAsset(`${photo}?x=1`, 'property_photo', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset(`${photo}#frag`, 'property_photo', CLOUD)).toBe(false);
  });

  it("refuse tout si le nom du compte Cloudinary n'est pas configuré", () => {
    expect(isOwnCloudinaryAsset(photo, 'property_photo', undefined)).toBe(false);
    expect(isOwnCloudinaryAsset(photo, 'property_photo', '')).toBe(false);
  });

  it("refuse ce qui n'est pas du texte, le texte vide et les adresses démesurées", () => {
    for (const bad of [undefined, null, 42, {}, [], '']) {
      expect(isOwnCloudinaryAsset(bad, 'property_photo', CLOUD)).toBe(false);
    }
    expect(isOwnCloudinaryAsset(`${photo.replace('abc123_XYZ-9', 'a'.repeat(600))}`, 'property_photo', CLOUD)).toBe(false);
  });
});

describe('isOwnCloudinaryAsset — documents KYC (livraison privée)', () => {
  const doc = `https://res.cloudinary.com/${CLOUD}/image/authenticated/v1700000000/soorooms/kyc/cni_01.jpg`;

  it('accepte un document privé, avec ou sans version, avec ou sans signature dans le chemin', () => {
    expect(isOwnCloudinaryAsset(doc, 'kyc_document', CLOUD)).toBe(true);
    expect(isOwnCloudinaryAsset(doc.replace('v1700000000/', ''), 'kyc_document', CLOUD)).toBe(true);
    expect(isOwnCloudinaryAsset(doc.replace('authenticated/', 'authenticated/s--AbCd_-12--/'), 'kyc_document', CLOUD)).toBe(true);
  });

  it('accepte un PDF', () => {
    expect(isOwnCloudinaryAsset(doc.replace('.jpg', '.pdf'), 'kyc_document', CLOUD)).toBe(true);
  });

  it("refuse un fichier PUBLIC donné comme pièce d'identité : il doit avoir été envoyé en livraison privée", () => {
    expect(isOwnCloudinaryAsset(doc.replace('/authenticated/', '/upload/'), 'kyc_document', CLOUD)).toBe(false);
  });

  it('refuse une photo de logement, un site extérieur et un autre compte', () => {
    expect(isOwnCloudinaryAsset(doc.replace('kyc', 'properties'), 'kyc_document', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset('https://example.com/cni.jpg', 'kyc_document', CLOUD)).toBe(false);
    expect(isOwnCloudinaryAsset(doc.replace(CLOUD, 'autre-compte'), 'kyc_document', CLOUD)).toBe(false);
  });

  it("refuse l'ancien dossier mal orthographié", () => {
    expect(isOwnCloudinaryAsset(doc.replace('soorooms/', 'sooroms/'), 'kyc_document', CLOUD)).toBe(false);
  });
});

describe('parsePrivateKycAsset', () => {
  it("extrait l'identifiant public (dossier compris) et le format", () => {
    const url = `https://res.cloudinary.com/${CLOUD}/image/authenticated/s--AbCd_-12--/v1700000000/soorooms/kyc/cni_01.pdf`;
    expect(parsePrivateKycAsset(url, CLOUD)).toEqual({ publicId: 'soorooms/kyc/cni_01', format: 'pdf' });
  });

  it("renvoie null pour un fichier public, une photo ou le compte d'un autre", () => {
    expect(parsePrivateKycAsset(`https://res.cloudinary.com/${CLOUD}/image/upload/soorooms/kyc/a.jpg`, CLOUD)).toBeNull();
    expect(parsePrivateKycAsset(`https://res.cloudinary.com/${CLOUD}/image/authenticated/soorooms/properties/a.jpg`, CLOUD)).toBeNull();
    expect(parsePrivateKycAsset(`https://res.cloudinary.com/autre/image/authenticated/soorooms/kyc/a.jpg`, CLOUD)).toBeNull();
  });
});

describe('signParams', () => {
  const secret = 'le-secret';

  it("suit la règle de Cloudinary : noms triés, « nom=valeur » joints par &, secret ajouté, SHA-1", () => {
    const expected = sha1(`allowed_formats=jpg,png&folder=soorooms/x&timestamp=1700000000${secret}`);
    expect(signParams({ timestamp: 1700000000, folder: 'soorooms/x', allowed_formats: 'jpg,png' }, secret)).toBe(expected);
  });

  it('ignore les paramètres sans valeur, mais signe `type` quand il est présent', () => {
    const base = { allowed_formats: 'jpg', folder: 'soorooms/x', timestamp: 1 };
    expect(signParams({ ...base, type: undefined }, secret)).toBe(signParams(base, secret));
    expect(signParams({ ...base, type: 'authenticated' }, secret)).toBe(
      sha1(`allowed_formats=jpg&folder=soorooms/x&timestamp=1&type=authenticated${secret}`),
    );
    expect(signParams({ ...base, type: 'authenticated' }, secret)).not.toBe(signParams(base, secret));
  });

  it('dépend du secret', () => {
    expect(signParams({ timestamp: 1 }, 'a')).not.toBe(signParams({ timestamp: 1 }, 'b'));
  });
});

describe('buildPrivateDownloadUrl', () => {
  const input = {
    cloudName: CLOUD,
    apiKey: '123456',
    apiSecret: 'le-secret',
    publicId: 'soorooms/kyc/cni_01',
    format: 'jpg',
    timestamp: 1700000000,
    expiresAt: 1700000600,
  };
  const url = new URL(buildPrivateDownloadUrl(input));

  it("vise l'API de téléchargement de notre compte", () => {
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/image/download`);
  });

  it('demande le fichier privé et fixe une expiration', () => {
    expect(url.searchParams.get('type')).toBe('authenticated');
    expect(url.searchParams.get('public_id')).toBe('soorooms/kyc/cni_01');
    expect(url.searchParams.get('format')).toBe('jpg');
    expect(url.searchParams.get('expires_at')).toBe('1700000600');
    expect(url.searchParams.get('timestamp')).toBe('1700000000');
    expect(url.searchParams.get('api_key')).toBe('123456');
  });

  it("est signé, et la signature couvre l'expiration (la rallonger invalide le lien)", () => {
    const signed = { expires_at: 1700000600, format: 'jpg', public_id: 'soorooms/kyc/cni_01', timestamp: 1700000000, type: 'authenticated' };
    expect(url.searchParams.get('signature')).toBe(signParams(signed, 'le-secret'));
    expect(url.searchParams.get('signature')).not.toBe(signParams({ ...signed, expires_at: 1700099999 }, 'le-secret'));
  });

  it('ne contient jamais le secret', () => {
    expect(url.toString()).not.toContain('le-secret');
  });
});
