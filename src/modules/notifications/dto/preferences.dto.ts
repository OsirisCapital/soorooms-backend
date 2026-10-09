import { IsBoolean } from 'class-validator';

export class SetPreferencesDto {
  @IsBoolean({ message: 'Choisissez « activé » ou « désactivé ».' })
  emailEnabled!: boolean;
}
