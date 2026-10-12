import { IsString, MaxLength, MinLength } from 'class-validator';

export class RequestAttestationDto {
  // Pays de résidence ou de nationalité : l'attestation vise les voyageurs venant de l'étranger.
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  country!: string;
}

export class DeclineAttestationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}
