/**
 * Valide l'access token JWT sur chaque requête protégée. Ne retourne
 * volontairement qu'un sous-ensemble minimal de l'utilisateur (id, role,
 * phone) : le payload du token ne doit jamais devenir une source de vérité
 * pour des données qui changent (le rôle d'un utilisateur peut évoluer
 * après l'émission du token — pour une vérification stricte et à jour,
 * un guard peut toujours recharger l'utilisateur complet depuis Prisma).
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AppConfig } from '../../../config/configuration.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

export interface JwtPayload {
  sub: string; // userId
  role: string;
  phone: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('jwt.accessSecret', { infer: true }),
    });
  }

  async validate(payload: JwtPayload) {
    // On vérifie que l'utilisateur existe toujours (pas seulement que le
    // token est signé correctement) : un compte supprimé ou suspendu après
    // l'émission du token ne doit pas rester utilisable jusqu'à expiration.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('Utilisateur introuvable.');
    }
    return { id: user.id, role: user.role, phone: user.phone };
  }
}
