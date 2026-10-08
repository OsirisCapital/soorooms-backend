import { IsOptional } from 'class-validator';
import { IsCloudinaryAsset } from '../../../common/validators/is-cloudinary-asset.js';

export class SubmitKycDto {
  @IsCloudinaryAsset('kyc_document', {
    message: "idCardUrl doit être un fichier envoyé depuis l'application : choisissez votre pièce d'identité sur votre appareil.",
  })
  idCardUrl!: string;

  @IsOptional()
  @IsCloudinaryAsset('kyc_document', {
    message: "proofOfAddressUrl doit être un fichier envoyé depuis l'application : choisissez votre justificatif sur votre appareil.",
  })
  proofOfAddressUrl?: string;
}
