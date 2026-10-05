import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateAmenitiesDto {
  @IsOptional()
  @IsBoolean()
  hasWifi?: boolean;

  @IsOptional()
  @IsBoolean()
  hasGeneratorOrSolar?: boolean;

  @IsOptional()
  @IsBoolean()
  hasAc?: boolean;

  @IsOptional()
  @IsBoolean()
  hasParking?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additionalEquipments?: string[];
}
