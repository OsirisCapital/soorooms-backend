import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ActivatePartnerDto {
  @IsBoolean()
  acceptTerms!: boolean;
}

export class ClaimReferralDto {
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  code!: string;
}

export class SuspendPartnerDto {
  @IsBoolean()
  suspended!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class RejectPartnerPayoutDto {
  @IsString()
  @MinLength(3, { message: 'Indiquez le motif du refus.' })
  @MaxLength(300)
  reason!: string;
}

export class UpdatePartnerConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) hostRatePercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) hostMonths?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) travelerRatePercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) travelerMonths?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) capPercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) minPayout?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) withholdingPercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) claimWindowDays?: number;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(20) termsVersion?: string;
}
