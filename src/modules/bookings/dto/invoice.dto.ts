import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Informations à faire figurer sur la facture d'une entreprise ou d'une organisation. */
export class IssueInvoiceDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  company!: string;

  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  address!: string;

  /** Numéro d'identifiant unique (NIU) ou équivalent du pays de l'entreprise. */
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9 .\-/]{5,25}$/, { message: "Numéro d'identification invalide (5 à 25 caractères, lettres et chiffres)." })
  taxId?: string;
}
