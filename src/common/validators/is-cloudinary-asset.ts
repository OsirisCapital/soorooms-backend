import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isOwnCloudinaryAsset, type AssetPurpose } from '../utils/cloudinary-assets.js';

/**
 * N'accepte qu'une URL de fichier envoyé par NOTRE application à NOTRE compte
 * Cloudinary, dans le dossier prévu pour l'usage. Un lien vers un site
 * extérieur (qui pourrait disparaître, changer ou pister les visiteurs) est
 * refusé, de même qu'un fichier d'un autre usage (une photo publique donnée
 * comme pièce d'identité, par exemple).
 *
 * Le nom du compte est lu à chaque validation dans CLOUDINARY_CLOUD_NAME :
 * absent, aucune URL n'est acceptée.
 */
export function IsCloudinaryAsset(purpose: AssetPurpose, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isCloudinaryAsset',
      target: object.constructor,
      propertyName,
      options: {
        message: "Ce fichier n'a pas été envoyé depuis l'application : choisissez-le depuis votre appareil.",
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) => isOwnCloudinaryAsset(value, purpose, process.env.CLOUDINARY_CLOUD_NAME),
      },
    });
  };
}
