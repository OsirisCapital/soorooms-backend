import { Type } from 'class-transformer';
import { IsDate, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_VISIT_PRICE, MIN_VISIT_PRICE } from '../../visits/visit.utils.js';
import { MAX_HOST_PERCENT, MAX_TRAVELER_PERCENT } from '../fees.utils.js';

/** Garde-fou : un pourcentage aberrant (faute de frappe) est refusé, même venant du super administrateur. */
export class UpdateFeesDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_HOST_PERCENT)
  hostCommissionPercent!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_HOST_PERCENT)
  launchHostCommissionPercent?: number | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  launchEndsAt?: Date | null;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_TRAVELER_PERCENT)
  travelerFeePercent!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_VISIT_PRICE)
  @Max(MAX_VISIT_PRICE)
  verificationVisitPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
