import { IsIn } from 'class-validator';

export const UPLOAD_PURPOSES = ['property_photo', 'kyc_document', 'avatar'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export class UploadSignatureDto {
  @IsIn(UPLOAD_PURPOSES, { message: 'purpose doit être property_photo, kyc_document ou avatar.' })
  purpose!: UploadPurpose;
}
