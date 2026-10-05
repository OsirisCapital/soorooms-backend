import { IsOptional, IsUrl } from 'class-validator';

export class SubmitKycDto {
  @IsUrl({}, { message: "idCardUrl doit être une URL valide vers le justificatif d'identité." })
  idCardUrl!: string;

  @IsOptional()
  @IsUrl({}, { message: 'proofOfAddressUrl doit être une URL valide.' })
  proofOfAddressUrl?: string;
}
