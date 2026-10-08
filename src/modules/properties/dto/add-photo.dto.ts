import { IsOptional, IsInt, Min } from 'class-validator';
import { IsCloudinaryAsset } from '../../../common/validators/is-cloudinary-asset.js';

export class AddPhotoDto {
  @IsCloudinaryAsset('property_photo', {
    message: "url doit être une photo envoyée depuis l'application : choisissez-la sur votre appareil.",
  })
  url!: string;

  // Position dans le carrousel — si omise, la photo est ajoutée à la fin.
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
