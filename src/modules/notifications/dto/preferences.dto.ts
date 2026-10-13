import { IsBoolean, IsOptional } from 'class-validator';

export class SetPreferencesDto {
  @IsOptional()
  @IsBoolean({ message: 'Choisissez « activé » ou « désactivé ».' })
  emailEnabled?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'Choisissez « activé » ou « désactivé ».' })
  whatsappEnabled?: boolean;
}
