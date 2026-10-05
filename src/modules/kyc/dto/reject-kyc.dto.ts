import { IsString, MinLength } from 'class-validator';

export class RejectKycDto {
  // Obligatoire : un rejet sans motif n'aide personne à corriger et
  // resoumettre correctement.
  @IsString()
  @MinLength(5, { message: 'Précisez le motif du rejet (5 caractères minimum).' })
  reviewerNote!: string;
}
