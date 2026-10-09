import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : trim({ value }));

export const AUDIENCES = ['ALL', 'TRAVELERS', 'HOSTS'] as const;

/** Une page de l'application seulement : commence par « / », jamais « // » ni adresse extérieure. */
const INTERNAL_PATH = /^\/(?!\/)[^\s\\]*$/;

export class AnnouncementDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Le titre doit faire 3 caractères au moins.' })
  @MaxLength(100, { message: 'Le titre est limité à 100 caractères.' })
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Le message doit faire 5 caractères au moins.' })
  @MaxLength(300, { message: 'Le message est limité à 300 caractères.' })
  body!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(INTERNAL_PATH, { message: 'Le lien doit être une page de l’application, par exemple /explorer.' })
  @MaxLength(200)
  href?: string;

  @IsIn(AUDIENCES, { message: 'Choisissez le public visé.' })
  audience!: (typeof AUDIENCES)[number];
}
