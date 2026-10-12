import { IsDateString, IsOptional } from 'class-validator';

/** Dates optionnelles pour afficher « X disponibles sur N » sur la fiche d'un logement. */
export class PropertyAvailabilityQueryDto {
  @IsOptional()
  @IsDateString()
  checkInDate?: string;

  @IsOptional()
  @IsDateString()
  checkOutDate?: string;
}
