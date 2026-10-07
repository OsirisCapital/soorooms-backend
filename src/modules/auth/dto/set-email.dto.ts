import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { normalizeEmail } from '../../../common/utils/email.js';

export class SetEmailDto {
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  email!: string;

  // Redemandé pour toute modification : un jeton d'accès volé ne doit pas suffire à rattacher
  // une adresse étrangère au compte, puis à le reprendre via « mot de passe oublié ».
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
