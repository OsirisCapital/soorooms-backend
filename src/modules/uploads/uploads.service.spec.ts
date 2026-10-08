import { createHash } from 'node:crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadsService } from './uploads.service.js';

const NOW = new Date('2026-10-08T10:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

function makeService(env: Record<string, string | undefined> = {}) {
  const values = { CLOUDINARY_CLOUD_NAME: 'demo-cloud', CLOUDINARY_API_KEY: '123456', CLOUDINARY_API_SECRET: 'le-secret', ...env };
  const config = { get: (key: string) => values[key as keyof typeof values] } as unknown as ConfigService;
  return new UploadsService(config);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('UploadsService.createSignature', () => {
  it('photo de logement : dossier soorooms/properties, livraison publique, trois paramètres signés', () => {
    const result = makeService().createSignature('property_photo');
    expect(result.folder).toBe('soorooms/properties');
    expect(result.type).toBeUndefined();
    expect(result.timestamp).toBe(NOW_S);
    expect(result.signature).toBe(
      sha1(`allowed_formats=jpg,jpeg,png,webp&folder=soorooms/properties&timestamp=${NOW_S}le-secret`),
    );
  });

  it('document KYC : dossier soorooms/kyc, livraison privée, et `type` fait partie de la signature', () => {
    const result = makeService().createSignature('kyc_document');
    expect(result.folder).toBe('soorooms/kyc');
    expect(result.type).toBe('authenticated');
    expect(result.allowedFormats).toBe('jpg,jpeg,png,webp,pdf');
    expect(result.signature).toBe(
      sha1(`allowed_formats=jpg,jpeg,png,webp,pdf&folder=soorooms/kyc&timestamp=${NOW_S}&type=authenticatedle-secret`),
    );
  });

  it("ne renvoie jamais le secret d'API", () => {
    expect(JSON.stringify(makeService().createSignature('kyc_document'))).not.toContain('le-secret');
  });

  it("répond 503 si Cloudinary n'est pas configuré", () => {
    for (const missing of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
      expect(() => makeService({ [missing]: undefined }).createSignature('kyc_document')).toThrow(ServiceUnavailableException);
    }
  });
});

describe('UploadsService.createViewUrl', () => {
  const privateDoc = 'https://res.cloudinary.com/demo-cloud/image/authenticated/v1700000000/soorooms/kyc/cni_01.jpg';

  it('document privé : lien signé de notre compte, valable 10 minutes', () => {
    const { url, expiresInSeconds } = makeService().createViewUrl(privateDoc);
    const link = new URL(url);

    expect(expiresInSeconds).toBe(600);
    expect(`${link.origin}${link.pathname}`).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/download');
    expect(link.searchParams.get('public_id')).toBe('soorooms/kyc/cni_01');
    expect(link.searchParams.get('format')).toBe('jpg');
    expect(link.searchParams.get('type')).toBe('authenticated');
    expect(link.searchParams.get('expires_at')).toBe(String(NOW_S + 600));
    expect(link.searchParams.get('signature')).toBe(
      sha1(`expires_at=${NOW_S + 600}&format=jpg&public_id=soorooms/kyc/cni_01&timestamp=${NOW_S}&type=authenticatedle-secret`),
    );
    expect(url).not.toContain('le-secret');
  });

  it("n'accepte pas de signer le fichier d'un autre compte Cloudinary", () => {
    const foreign = privateDoc.replace('demo-cloud', 'autre-compte');
    const { url, expiresInSeconds } = makeService().createViewUrl(foreign);
    expect(url).toBe(foreign); // renvoyé tel quel, jamais signé avec nos clés
    expect(expiresInSeconds).toBeNull();
  });

  it('ancien document public (avant la livraison privée) : renvoyé tel quel', () => {
    const legacy = 'https://res.cloudinary.com/demo-cloud/image/upload/v1/sooroms/kyc/old.jpg';
    expect(makeService().createViewUrl(legacy)).toEqual({ url: legacy, expiresInSeconds: null });
  });

  it('refuse ce qui n’est pas un lien web (javascript:, texte, vide)', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'pas un lien', '']) {
      expect(() => makeService().createViewUrl(bad)).toThrow(BadRequestException);
    }
  });

  it("répond 503 pour un document privé si les clés Cloudinary manquent", () => {
    expect(() => makeService({ CLOUDINARY_API_SECRET: undefined }).createViewUrl(privateDoc)).toThrow(ServiceUnavailableException);
  });
});
