/**
 * Délègue l'inscription/connexion à Google OAuth. Le contrôleur (voir
 * auth.controller.ts) reçoit le profil validé ici et appelle
 * AuthService.loginWithGoogle, qui crée le compte à la première connexion
 * ou récupère le compte existant sinon — sans jamais demander de mot de
 * passe ni de KYC pour un simple voyageur.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import type { AppConfig } from '../../../config/configuration.js';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService<AppConfig, true>) {
    super({
      clientID: configService.get('google.clientId', { infer: true }),
      clientSecret: configService.get('google.clientSecret', { infer: true }),
      callbackURL: configService.get('google.callbackUrl', { infer: true }),
      scope: ['email', 'profile'],
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile, done: VerifyCallback) {
    const { id, displayName, emails, photos } = profile;
    // `verified` n'est pas déclaré dans les types de passport-google-oauth20, mais Google le fournit.
    const first = emails?.[0] as { value: string; verified?: boolean | string } | undefined;
    done(null, {
      googleId: id,
      fullName: displayName,
      email: first?.value,
      // Sans cette garantie de Google, l'adresse n'est jamais traitée comme prouvée.
      emailVerified: first?.verified === true || first?.verified === 'true',
      avatarUrl: photos?.[0]?.value,
    });
  }
}
