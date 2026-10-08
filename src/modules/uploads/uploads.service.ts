/**
 * Téléversement direct vers Cloudinary : le client envoie le fichier à
 * Cloudinary lui-même (rien ne transite par ce serveur), mais seulement avec
 * une signature produite ici. Le secret d'API ne quitte donc jamais le
 * backend, et la signature fige le dossier, les formats autorisés et le
 * régime de livraison.
 *
 * Les documents du KYC sont envoyés en livraison privée (« authenticated ») :
 * leur lien direct ne marche pas, et seul un administrateur peut obtenir un
 * lien temporaire via createViewUrl().
 *
 * Variables d'environnement : CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
 * CLOUDINARY_API_SECRET.
 */
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ASSET_RULES,
  PRIVATE_LINK_TTL_SECONDS,
  buildPrivateDownloadUrl,
  parsePrivateKycAsset,
  signParams,
} from '../../common/utils/cloudinary-assets.js';
import type { UploadPurpose } from './dto/upload-signature.dto.js';

@Injectable()
export class UploadsService {
  constructor(private readonly config: ConfigService) {}

  private credentials() {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException("Le téléversement de fichiers n'est pas encore configuré.");
    }
    return { cloudName, apiKey, apiSecret };
  }

  createSignature(purpose: UploadPurpose) {
    const { cloudName, apiKey, apiSecret } = this.credentials();
    const { folder, allowedFormats, deliveryType } = ASSET_RULES[purpose];
    const timestamp = Math.floor(Date.now() / 1000);

    // `type` n'est envoyé (et donc signé) que pour la livraison privée : le
    // client doit le renvoyer tel quel à Cloudinary, sinon la signature échoue.
    const type = deliveryType === 'authenticated' ? deliveryType : undefined;
    const signature = signParams({ allowed_formats: allowedFormats, folder, timestamp, type }, apiSecret);

    return { cloudName, apiKey, timestamp, signature, folder, allowedFormats, type };
  }

  /**
   * Lien de consultation d'un document déjà envoyé. Un document privé donne un
   * lien signé qui expire ; les documents antérieurs au passage en livraison
   * privée (simples URL publiques) sont renvoyés tels quels.
   */
  createViewUrl(storedUrl: string): { url: string; expiresInSeconds: number | null } {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const privateAsset = cloudName ? parsePrivateKycAsset(storedUrl, cloudName) : null;

    if (privateAsset) {
      const { cloudName: name, apiKey, apiSecret } = this.credentials();
      const timestamp = Math.floor(Date.now() / 1000);
      const url = buildPrivateDownloadUrl({
        cloudName: name,
        apiKey,
        apiSecret,
        ...privateAsset,
        timestamp,
        expiresAt: timestamp + PRIVATE_LINK_TTL_SECONDS,
      });
      return { url, expiresInSeconds: PRIVATE_LINK_TTL_SECONDS };
    }

    let protocol: string;
    try {
      protocol = new URL(storedUrl).protocol;
    } catch {
      throw new BadRequestException("Ce document n'a pas de lien valide.");
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new BadRequestException("Ce document n'a pas de lien valide.");
    }
    return { url: storedUrl, expiresInSeconds: null };
  }
}
