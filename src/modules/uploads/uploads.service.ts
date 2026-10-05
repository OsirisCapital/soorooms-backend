/**
 * Téléversement direct vers Cloudinary : le client envoie le fichier à
 * Cloudinary lui-même (rien ne transite par ce serveur), mais seulement avec
 * une signature produite ici. Le secret d'API ne quitte donc jamais le
 * backend, et la signature fige le dossier et les formats autorisés.
 *
 * Variables d'environnement : CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
 * CLOUDINARY_API_SECRET.
 */
import { createHash } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UploadPurpose } from './dto/upload-signature.dto.js';

const SETTINGS: Record<UploadPurpose, { folder: string; allowedFormats: string }> = {
  property_photo: { folder: 'sooroms/properties', allowedFormats: 'jpg,jpeg,png,webp' },
  kyc_document: { folder: 'sooroms/kyc', allowedFormats: 'jpg,jpeg,png,webp,pdf' },
};

@Injectable()
export class UploadsService {
  constructor(private readonly config: ConfigService) {}

  createSignature(purpose: UploadPurpose) {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException("Le téléversement de fichiers n'est pas encore configuré.");
    }

    const { folder, allowedFormats } = SETTINGS[purpose];
    const timestamp = Math.floor(Date.now() / 1000);

    // Règle Cloudinary : paramètres signés triés par nom, joints en
    // « nom=valeur&… », suivis du secret, puis SHA-1 en hexadécimal. Le fichier,
    // api_key, cloud_name et resource_type ne font pas partie de la signature.
    const toSign = `allowed_formats=${allowedFormats}&folder=${folder}&timestamp=${timestamp}`;
    const signature = createHash('sha1').update(toSign + apiSecret).digest('hex');

    return { cloudName, apiKey, timestamp, signature, folder, allowedFormats };
  }
}
