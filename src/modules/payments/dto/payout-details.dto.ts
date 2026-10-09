import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { PAYOUT_CHANNELS } from '../payout-phone.js';

export class SetPayoutDetailsDto {
  @IsIn([...PAYOUT_CHANNELS], { message: 'Choisissez MTN Mobile Money ou Orange Money.' })
  channel!: (typeof PAYOUT_CHANNELS)[number];

  @IsString()
  @MinLength(8, { message: 'Numéro trop court.' })
  @MaxLength(25, { message: 'Numéro trop long.' })
  phone!: string;

  @IsString()
  @MinLength(2, { message: 'Indiquez le nom du titulaire du compte.' })
  @MaxLength(80)
  accountName!: string;
}
