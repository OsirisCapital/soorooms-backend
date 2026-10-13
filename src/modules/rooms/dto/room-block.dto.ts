import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateRoomBlockDto {
  /** Premier jour fermé (AAAA-MM-JJ). */
  @Matches(DAY, { message: 'Indiquez le premier jour fermé (AAAA-MM-JJ).' })
  startDate!: string;

  /** Dernier jour fermé, inclus (AAAA-MM-JJ). Le logement rouvre le lendemain. */
  @Matches(DAY, { message: 'Indiquez le dernier jour fermé (AAAA-MM-JJ).' })
  endDate!: string;

  /** Nombre d'unités fermées ; vide = tout le type de chambre. */
  @IsOptional()
  @IsInt({ message: "Le nombre d'unités doit être un nombre entier." })
  @Min(1, { message: 'Fermez au moins une unité.' })
  @Max(500)
  units?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120, { message: 'Le motif est limité à 120 caractères.' })
  reason?: string;
}
