import { IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateRoomDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  roomType!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99_999_999)
  basePrice!: number;

  @IsInt()
  @Min(1)
  maxGuests!: number;

  // Optionnels (par défaut 1) : pour une "maison entière" représentée par
  // une seule Room, ces deux champs alimentent l'affichage "4 chambres,
  // 8 lits" des maquettes. Sans objet pour une chambre d'hôtel classique,
  // qui garde la valeur par défaut.
  @IsOptional()
  @IsInt()
  @Min(1)
  bedCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  bedroomCount?: number;
}
