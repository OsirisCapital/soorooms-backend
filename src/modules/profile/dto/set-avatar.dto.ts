import { IsCloudinaryAsset } from '../../../common/validators/is-cloudinary-asset.js';

export class SetAvatarDto {
  // Seule une photo envoyée depuis l'application est acceptée : jamais un lien vers un site extérieur.
  @IsCloudinaryAsset('avatar', { message: "La photo doit être envoyée depuis l'application : choisissez-la sur votre appareil." })
  avatarUrl!: string;
}
