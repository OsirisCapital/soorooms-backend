import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Payeur qui ouvre un lien de paiement (diaspora) : pas de compte, juste de quoi lui envoyer la confirmation. */
export class PayLinkInitiateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  payerName!: string;

  @IsEmail()
  @MaxLength(160)
  payerEmail!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ]{8,20}$/, { message: 'Numéro de téléphone invalide.' })
  payerPhone?: string;
}
