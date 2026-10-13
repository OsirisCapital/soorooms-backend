import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateReviewDto {
  @IsInt({ message: 'Choisissez une note de 1 à 5.' })
  @Min(1, { message: 'Choisissez une note de 1 à 5.' })
  @Max(5, { message: 'Choisissez une note de 1 à 5.' })
  rating!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000, { message: 'Le commentaire est limité à 1000 caractères.' })
  comment?: string;
}

export class ReplyReviewDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Écrivez votre réponse.' })
  @MaxLength(600, { message: 'La réponse est limitée à 600 caractères.' })
  reply!: string;
}
