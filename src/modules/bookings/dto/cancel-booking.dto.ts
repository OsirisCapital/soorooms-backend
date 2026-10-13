import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PAYOUT_CHANNELS } from '../../payments/payout-phone.js';

export class CancelBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /** Où rembourser (voyageur) : requis seulement si un remboursement est dû. */
  @IsOptional()
  @IsIn([...PAYOUT_CHANNELS], { message: 'Choisissez MTN Mobile Money ou Orange Money.' })
  refundChannel?: (typeof PAYOUT_CHANNELS)[number];

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Numéro trop court.' })
  @MaxLength(25, { message: 'Numéro trop long.' })
  refundPhone?: string;

  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Indiquez le nom du titulaire du compte.' })
  @MaxLength(80)
  refundName?: string;
}
