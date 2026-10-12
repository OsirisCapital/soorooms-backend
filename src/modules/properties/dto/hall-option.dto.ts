import { Transform } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateHallOptionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  @Max(99_999_999)
  price!: number;

  @IsOptional()
  @IsBoolean()
  perNight?: boolean;
}
