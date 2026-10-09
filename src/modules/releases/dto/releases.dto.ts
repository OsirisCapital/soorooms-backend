import { Transform } from 'class-transformer';
import { IsBoolean, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { VERSION_PATTERN } from '../semver.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PublishReleaseDto {
  @Transform(trim)
  @Matches(VERSION_PATTERN, { message: 'La version doit avoir la forme 1.2.0.' })
  version!: string;

  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Décrivez la nouveauté (5 caractères minimum).' })
  @MaxLength(500, { message: 'Les notes sont limitées à 500 caractères.' })
  notes!: string;

  /** Oui : les applications plus anciennes sont bloquées jusqu'à leur mise à jour. */
  @IsBoolean()
  required!: boolean;
}

export class SetRequiredDto {
  @IsBoolean()
  required!: boolean;
}
