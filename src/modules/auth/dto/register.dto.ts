/**
 * Inscription par identifiants classiques (email/téléphone + mot de passe).
 * Utilisée aussi bien par un voyageur que par un hôte : le rôle par défaut
 * est TRAVELER, un utilisateur ne peut jamais s'auto-attribuer HOST ou
 * ADMIN via ce endpoint (le champ n'existe même pas dans ce DTO — voir
 * ValidationPipe({ forbidNonWhitelisted: true }) dans main.ts, qui rejette
 * toute tentative d'injecter un champ "role" non déclaré ici).
 */
import { IsEmail, IsPhoneNumber, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizeEmail } from '../../../common/utils/email.js';
import { normalizePhone } from '../../../common/utils/phone.js';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  fullName!: string;

  @Transform(({ value }) => normalizePhone(value))
  @IsPhoneNumber('CM', { message: 'Numéro de téléphone camerounais invalide.' })
  phone!: string;

  // Obligatoire : c'est le seul moyen sûr de récupérer un compte dont on a oublié le mot de passe.
  // L'adresse n'est utilisable qu'après vérification (lien envoyé par e-mail).
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'Adresse e-mail invalide.' }) // vérifie aussi la longueur maximale (254)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Le mot de passe doit faire au moins 8 caractères.' })
  password!: string;
}
