import { IsEnum, IsLatitude, IsLongitude, IsOptional, IsString, MinLength } from 'class-validator';
import { PropertyType } from '../../../prisma/client.js';

export class CreatePropertyDto {
  @IsString()
  @MinLength(3)
  title!: string;

  // Minimum volontairement bas (20 caractères) : l'hôte rédige librement,
  // voir la décision produit — pas de formulaire structuré à ce stade, un
  // futur programme d'analyse mettra en valeur les informations clés.
  @IsString()
  @MinLength(20, { message: 'Décrivez le logement un peu plus en détail (20 caractères minimum).' })
  description!: string;

  @IsEnum(PropertyType)
  propertyType!: PropertyType;

  @IsString()
  city!: string;

  @IsString()
  quarter!: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;
}
