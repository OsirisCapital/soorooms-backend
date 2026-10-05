import { IsNumber, Max, Min } from 'class-validator';

export class CreateOfferDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99_999_999)
  amount!: number;
}
