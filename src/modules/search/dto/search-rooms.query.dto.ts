/**
 * Tous les champs sont optionnels — une recherche vide renvoie tous les
 * logements ACTIVE, triés par prix croissant. Les paramètres de requête
 * HTTP arrivent toujours en chaînes de caractères ; @Type()/@Transform()
 * les convertissent avant validation (notamment les booléens : la
 * conversion JS naïve Boolean("false") vaut true, d'où le transform
 * explicite ci-dessous).
 */
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { PropertyType } from '../../../prisma/client.js';

const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class SearchRoomsQueryDto {
  // Pays (nom ou code ISO). Un logement sans pays renseigné compte comme camerounais (données historiques).
  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  quarter?: string;

  // Les deux doivent être fournies ensemble pour filtrer par disponibilité
  // réelle (voir SearchService) — fournir l'une sans l'autre est ignoré
  // plutôt que rejeté, une recherche sans dates reste un usage valide
  // (parcourir les logements sans projet de séjour précis).
  @IsOptional()
  @IsDateString()
  checkInDate?: string;

  @IsOptional()
  @IsDateString()
  checkOutDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsEnum(PropertyType)
  propertyType?: PropertyType;

  // Nombre de voyageurs à loger — la recherche ne retient que les
  // chambres pouvant accueillir AU MOINS ce nombre de personnes.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxGuests?: number;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasWifi?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasGeneratorOrSolar?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasAc?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasParking?: boolean;

  // Mode sieste : ne garde que les chambres qui acceptent les siestes (prix = tarif de sieste).
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  nap?: boolean;

  // Mode sieste : ampoule allumée (true) ou éteinte (false).
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  napBulb?: boolean;

  // « price » (défaut) : moins cher d'abord ; « verified » : logements vérifiés sur place en tête.
  @IsOptional()
  @IsIn(['price', 'verified'])
  sort?: 'price' | 'verified';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
