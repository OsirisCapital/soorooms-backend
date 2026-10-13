import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateSupportContactDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Donnez un nom à ce contact (par exemple « Support SòôRooms »).' })
  @MaxLength(60, { message: 'Le nom est limité à 60 caractères.' })
  label!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(25)
  phone!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80, { message: 'Les horaires sont limités à 80 caractères.' })
  hours?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}

export class UpdateSupportContactDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(25)
  phone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  hours?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}
