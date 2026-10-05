/**
 * Logique métier de l'authentification : inscription/connexion classique,
 * connexion Google, émission et rotation des tokens JWT.
 *
 * Principe de sécurité central : un refresh token n'est jamais stocké en
 * clair. On stocke son empreinte SHA-256 dans RefreshToken.tokenHash, ce
 * qui permet de le révoquer immédiatement (déconnexion, compromission
 * suspectée) et de détecter une réutilisation après rotation — un refresh
 * token n'est utilisable qu'une seule fois.
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { StringValue } from 'ms';
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BecomeHostDto } from './dto/become-host.dto.js';
import type { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { ResetPasswordDto } from './dto/reset-password.dto.js';
import type { JwtPayload } from './strategies/jwt.strategy.js';

const BCRYPT_SALT_ROUNDS = 12;

interface GoogleProfile {
  googleId: string;
  fullName?: string;
  email?: string;
  avatarUrl?: string;
}

// Exportée : TS l'exige dès qu'un type apparaît dans le type de retour
// (même déduit) d'une méthode publique, sous peine de TS4053 — voir
// AuthController où register/login/refresh/googleCallback retournent ce
// type sans l'annoter explicitement.
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  // ---------------------------------------------------------------------
  // Inscription / connexion classiques (voyageur ou hôte)
  // ---------------------------------------------------------------------

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing) {
      throw new ConflictException('Un compte existe déjà avec ce numéro de téléphone.');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const user = await this.prisma.user.create({
      data: {
        fullName: dto.fullName,
        phone: dto.phone,
        passwordHash,
        // role: TRAVELER par défaut (voir schema.prisma) — jamais assignable
        // depuis ce DTO, voir le commentaire dans register.dto.ts.
      },
    });

    return this.issueTokenPair(user.id, user.role, user.phone);
  }

  async validateCredentials(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    // Message volontairement identique que le compte existe ou non, pour ne
    // pas révéler à un attaquant si un numéro de téléphone est enregistré.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Identifiants invalides.');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Identifiants invalides.');
    }

    return this.issueTokenPair(user.id, user.role, user.phone);
  }

  // ---------------------------------------------------------------------
  // Connexion Google (voyageurs principalement — zéro friction, zéro KYC)
  // ---------------------------------------------------------------------

  async loginWithGoogle(profile: GoogleProfile) {
    let user = await this.prisma.user.findUnique({ where: { googleId: profile.googleId } });

    if (!user && profile.email) {
      // Cas où l'utilisateur s'était déjà inscrit par téléphone/mot de passe
      // et se connecte maintenant via Google avec le même e-mail : on relie
      // les deux plutôt que de créer un doublon.
      user = await this.prisma.user.findUnique({ where: { email: profile.email } });
      if (user) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { googleId: profile.googleId },
        });
      }
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          googleId: profile.googleId,
          fullName: profile.fullName ?? 'Utilisateur SòôRooms',
          email: profile.email,
          avatarUrl: profile.avatarUrl,
          // phone reste vide à la création via Google : à compléter plus
          // tard si l'utilisateur veut réserver (Mobile Money exige un
          // numéro). Non bloquant pour la simple navigation/recherche.
          phone: `google:${profile.googleId}`,
        },
      });
    }

    return this.issueTokenPair(user.id, user.role, user.phone);
  }

  // ---------------------------------------------------------------------
  // Rotation et révocation des refresh tokens
  // ---------------------------------------------------------------------

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.configService.get('jwt.refreshSecret', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré.');
    }

    const tokenHash = this.hashToken(refreshToken);
    const storedToken = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    // Le token est valide cryptographiquement mais absent (ou déjà révoqué)
    // en base : soit il a déjà été utilisé une fois (rotation), soit il a
    // été révoqué explicitement (déconnexion). Dans les deux cas, on
    // refuse — la réutilisation d'un refresh token déjà consommé est un
    // signal classique de vol de token.
    if (!storedToken || storedToken.revokedAt) {
      throw new UnauthorizedException('Ce refresh token a déjà été utilisé ou révoqué.');
    }

    // Rotation : on révoque l'ancien avant d'en émettre un nouveau.
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    // Rôle et téléphone relus en base (et non recopiés de l'ancien token) : un
    // compte passé HOST depuis, ou supprimé entre-temps, doit être pris en compte.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('Compte introuvable.');
    }
    return this.issueTokenPair(user.id, user.role, user.phone);
  }

  async logout(userId: string) {
    // Révoque tous les refresh tokens actifs de l'utilisateur — une
    // déconnexion doit invalider la session partout, pas juste sur l'appareil
    // courant.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------
  // Bascule TRAVELER -> HOST (sans déclencher le KYC, voir become-host.dto)
  // ---------------------------------------------------------------------

  // Jamais de passwordHash ni de googleId dans cette réponse : on sélectionne
  // explicitement les champs exposables.
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        kycStatus: true,
        avatarUrl: true,
        createdAt: true,
        hostProfile: { select: { bio: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('Compte introuvable.');
    }
    return user;
  }

  async becomeHost(userId: string, dto: BecomeHostDto) {
    return this.prisma.$transaction(async (tx) => {
      // Seul un voyageur change de rôle : un ADMIN qui ouvre un profil hôte
      // garde ses droits d'administration (sinon l'appel le rétrograderait).
      const current = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (current?.role === 'TRAVELER') {
        await tx.user.update({ where: { id: userId }, data: { role: 'HOST' } });
      }
      return tx.hostProfile.upsert({
        where: { userId },
        create: { userId, bio: dto.bio },
        update: { bio: dto.bio },
      });
    });
  }

  // ---------------------------------------------------------------------
  // Mot de passe oublié
  // ---------------------------------------------------------------------

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    // Réponse volontairement identique que le compte existe ou non — même
    // principe que pour la connexion, ne jamais révéler si un numéro est
    // enregistré.
    const genericResponse = { message: 'Si ce compte existe, des instructions ont été envoyées.' };

    if (!user || !user.passwordHash) {
      // Pas de compte, ou compte Google-only sans mot de passe à
      // réinitialiser — dans les deux cas, même réponse.
      return genericResponse;
    }

    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
      },
    });

    // TODO : envoyer rawToken par SMS (ou email) une fois un fournisseur
    // branché — même schéma que PaymentGateway pour Notch Pay, voir
    // src/modules/payments/gateways/notchpay.gateway.ts. En attendant, on
    // le renvoie directement hors production pour tester le flux complet
    // sans dépendre d'un service tiers.
    const isProduction = this.configService.get('nodeEnv', { infer: true }) === 'production';
    return isProduction ? genericResponse : { ...genericResponse, devResetToken: rawToken };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = this.hashToken(dto.token);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Lien de réinitialisation invalide ou expiré.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_SALT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      // Un changement de mot de passe invalide toutes les sessions actives
      // — sécurité de base si le mot de passe a fuité.
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return { message: 'Mot de passe réinitialisé avec succès.' };
  }

  // ---------------------------------------------------------------------
  // Émission des tokens
  // ---------------------------------------------------------------------

  private async issueTokenPair(userId: string, role: string, phone: string): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, role, phone };

    const accessExpiresIn = this.configService.get('jwt.accessExpiresIn', { infer: true });
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get('jwt.accessSecret', { infer: true }),
      // Cast nécessaire : ConfigService renvoie un `string` générique, mais
      // jsonwebtoken exige le type gabarit `StringValue` de la lib `ms`
      // (ex: "15m", "7d") — la valeur est validée au démarrage par
      // env.validation.ts, ce cast ne fait que satisfaire TypeScript sur
      // une forme déjà garantie correcte à l'exécution.
      expiresIn: accessExpiresIn as StringValue,
    });

    const refreshExpiresIn = this.configService.get('jwt.refreshExpiresIn', { infer: true });
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get('jwt.refreshSecret', { infer: true }),
      expiresIn: refreshExpiresIn as StringValue,
    });

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: this.parseExpiresInToDate(refreshExpiresIn),
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Convertit "7d" / "15m" / "3600" (secondes) en Date absolue. */
  private parseExpiresInToDate(expiresIn: string): Date {
    const match = /^(\d+)([smhd])?$/.exec(expiresIn.trim());
    const value = match ? parseInt(match[1], 10) : 3600;
    const unit = match?.[2] ?? 's';
    const unitToMs: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() + value * (unitToMs[unit] ?? 1_000));
  }
}
