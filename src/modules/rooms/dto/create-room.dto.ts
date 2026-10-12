import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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

  // Résidence étudiante : forfaits au semestre et à l'année (null = non proposé).
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99_999_999)
  semesterPrice?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99_999_999)
  yearPrice?: number | null;

  // Nombre de chambres identiques de ce type (par défaut 1). Un hôtel qui a 20 chambres
  // « Standard » crée UN type avec 20 unités plutôt que 20 fiches.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  unitCount?: number;

  // Siestes (hôtels et auberges) : séjour de quelques heures, au tarif propre à la chambre.
  @IsOptional()
  @IsBoolean()
  allowsNap?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99_999_999)
  napPrice?: number | null;

  // Durée d'une sieste, en heures.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  napHours?: number | null;

  // Réglage « ampoule » de la chambre de sieste : allumée (true) ou éteinte (false).
  @IsOptional()
  @IsBoolean()
  napBulb?: boolean;

  // Équipements de la chambre (liste libre : propositions + ajouts de l'hôte).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(60, { each: true })
  equipments?: string[];
}
