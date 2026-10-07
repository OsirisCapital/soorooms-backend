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
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { StringValue } from 'ms';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { passwordResetEmail, verificationEmail } from '../mail/mail.templates.js';
import type { BecomeHostDto } from './dto/become-host.dto.js';
import type { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { ResetPasswordDto } from './dto/reset-password.dto.js';
import type { SetEmailDto } from './dto/set-email.dto.js';
import type { JwtPayload } from './strategies/jwt.strategy.js';

const BCRYPT_SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_VALIDITY_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_VALIDITY_MINUTES = 30;
// Délai minimal entre deux e-mails du même type pour un même compte : empêche d'inonder la boîte de quelqu'un.
const MAIL_COOLDOWN_MS = 60 * 1000;

type UserDb = Pick<PrismaService, 'user'>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

interface GoogleProfile {
  googleId: string;
  fullName?: string;
  email?: string;
  /** Google garantit-il que l'adresse appartient bien à cette personne ? */
  emailVerified?: boolean;
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly mailService: MailService,
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

    let user;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        await this.claimEmail(tx, dto.email);
        return tx.user.create({
          data: {
            fullName: dto.fullName,
            phone: dto.phone,
            email: dto.email,
            passwordHash,
            // role: TRAVELER par défaut (voir schema.prisma) — jamais assignable
            // depuis ce DTO, voir le commentaire dans register.dto.ts.
            // emailVerifiedAt reste vide : l'adresse n'est pas prouvée tant que le lien n'a pas été ouvert.
          },
        });
      });
    } catch (error) {
      // Deux inscriptions simultanées avec le même numéro ou la même adresse.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Un compte existe déjà avec ce numéro de téléphone ou cette adresse e-mail.');
      }
      throw error;
    }

    // En arrière-plan : un e-mail qui tarde ou échoue ne doit ni ralentir ni empêcher l'inscription.
    // L'utilisateur pourra redemander le lien depuis « Mes informations ».
    void this.sendVerificationEmail(user);

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
    // Une adresse n'est retenue que si Google la garantit.
    const googleEmail =
      profile.email && profile.emailVerified ? profile.email.trim().toLowerCase() : undefined;

    let user = await this.prisma.user.findUnique({ where: { googleId: profile.googleId } });

    if (!user && googleEmail) {
      const holder = await this.prisma.user.findUnique({ where: { email: googleEmail } });
      if (holder?.emailVerifiedAt) {
        // Cas où l'utilisateur s'était déjà inscrit par téléphone et se connecte maintenant via
        // Google avec le même e-mail. Les DEUX côtés ont prouvé l'adresse (lien ouvert, puis
        // garantie de Google) : c'est bien la même personne, on relie plutôt que de dupliquer.
        user = await this.prisma.user.update({
          where: { id: holder.id },
          data: { googleId: profile.googleId },
        });
      } else if (holder) {
        // Adresse saisie à l'inscription mais JAMAIS vérifiée : rien ne prouve que son détenteur
        // en soit le propriétaire. Quelqu'un a pu s'inscrire avec l'adresse d'autrui pour récupérer
        // son compte Google le jour où il se connecterait. On ne relie donc jamais à un tel compte :
        // on libère l'adresse, et le compte Google est créé séparément, ci-dessous.
        await this.prisma.user.update({ where: { id: holder.id }, data: { email: null } });
      }
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          googleId: profile.googleId,
          fullName: profile.fullName ?? 'Utilisateur SòôRooms',
          email: googleEmail,
          emailVerifiedAt: googleEmail ? new Date() : null,
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
        emailVerifiedAt: true,
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
    // Réponse volontairement identique que le compte existe ou non, qu'il ait une adresse ou non —
    // même principe que pour la connexion : ne jamais révéler si un numéro est enregistré.
    const genericResponse = {
      message: 'Si ce compte existe et possède une adresse e-mail vérifiée, un lien de réinitialisation vient de lui être envoyé.',
    };

    if (!user || !user.passwordHash) {
      // Pas de compte, ou compte Google-only sans mot de passe à réinitialiser.
      return genericResponse;
    }

    const isProduction = this.configService.get('nodeEnv', { infer: true }) === 'production';
    // Le lien n'est envoyé qu'à une adresse PROUVÉE : une adresse mal saisie à l'inscription
    // appartient peut-être à un inconnu, qui pourrait alors prendre le compte.
    const canEmail = Boolean(user.email && user.emailVerifiedAt);
    if (!canEmail && isProduction) {
      return genericResponse;
    }

    const recent = await this.prisma.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - MAIL_COOLDOWN_MS) } },
    });
    if (recent) {
      return genericResponse;
    }

    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_VALIDITY_MINUTES * 60 * 1000),
      },
    });

    if (canEmail && user.email) {
      const frontendUrl = this.configService.get('frontendUrl', { infer: true });
      const url = `${frontendUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
      // Sans attendre la réponse de Brevo : le temps de réponse ne doit pas trahir l'existence du compte.
      void this.mailService.send({
        to: { email: user.email, name: user.fullName },
        ...passwordResetEmail({ fullName: user.fullName, url, validityMinutes: PASSWORD_RESET_VALIDITY_MINUTES }),
      });
    }

    // Hors production uniquement : le jeton est renvoyé pour tester sans boîte e-mail.
    return isProduction ? genericResponse : { ...genericResponse, devResetToken: rawToken };
  }

  // ---------------------------------------------------------------------
  // Vérification de l'adresse e-mail
  // ---------------------------------------------------------------------

  async verifyEmail(token: string) {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });
    const invalid = new UnauthorizedException('Lien de vérification invalide ou expiré.');

    if (!record) throw invalid;
    // L'adresse du compte a changé (ou a été libérée) depuis l'envoi : ce lien ne la concerne plus.
    if (!record.user.email || record.user.email !== record.email) throw invalid;

    if (record.usedAt) {
      // Lien ouvert deux fois (double-clic, aperçu de la messagerie) : on ne punit pas l'utilisateur.
      if (record.user.emailVerifiedAt) return { message: 'Votre adresse e-mail est déjà vérifiée.' };
      throw invalid;
    }
    if (record.expiresAt < new Date()) throw invalid;

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: now } });
      await tx.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: now } });
    });
    return { message: 'Adresse e-mail vérifiée.' };
  }

  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Compte introuvable.');
    if (!user.email) throw new BadRequestException("Ajoutez d'abord une adresse e-mail à votre compte.");
    if (user.emailVerifiedAt) return { message: 'Votre adresse e-mail est déjà vérifiée.' };

    const recent = await this.prisma.emailVerificationToken.findFirst({
      where: { userId, createdAt: { gt: new Date(Date.now() - MAIL_COOLDOWN_MS) } },
    });
    if (recent) {
      throw new HttpException(
        "Un e-mail vient d'être envoyé. Patientez une minute avant d'en demander un autre.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!(await this.sendVerificationEmail(user))) {
      throw new ServiceUnavailableException("L'envoi de l'e-mail est momentanément indisponible. Réessayez dans un instant.");
    }
    return { message: 'E-mail de vérification envoyé.' };
  }

  /** Ajoute ou remplace l'adresse e-mail d'un compte à mot de passe (comptes créés avant l'e-mail obligatoire, faute de frappe…). */
  async setEmail(userId: string, dto: SetEmailDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Compte introuvable.');
    if (!user.passwordHash) {
      throw new BadRequestException("Ce compte se connecte avec Google : son adresse e-mail est gérée par Google.");
    }
    if (!dto.currentPassword || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }
    if (user.email === dto.email) {
      return this.resendVerification(userId);
    }

    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        await this.claimEmail(tx, dto.email, userId);
        // Les liens de réinitialisation déjà émis partaient vers l'ancienne adresse : on les annule.
        await tx.passwordResetToken.updateMany({
          where: { userId, usedAt: null },
          data: { usedAt: new Date() },
        });
        return tx.user.update({ where: { id: userId }, data: { email: dto.email, emailVerifiedAt: null } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Un compte existe déjà avec cette adresse e-mail.');
      throw error;
    }

    const emailSent = await this.sendVerificationEmail(updated);
    return {
      emailSent,
      message: emailSent
        ? 'Adresse enregistrée. Un e-mail de vérification vient de vous être envoyé.'
        : "Adresse enregistrée, mais l'e-mail n'a pas pu partir : demandez un nouvel envoi dans un instant.",
    };
  }

  /**
   * Réserve une adresse pour un compte. Une adresse déjà VÉRIFIÉE chez quelqu'un d'autre est refusée.
   * Une adresse jamais vérifiée n'appartient encore à personne : elle est libérée, sinon n'importe
   * qui pourrait « squatter » l'adresse d'autrui en s'inscrivant avec elle et l'empêcher de s'inscrire.
   */
  private async claimEmail(db: UserDb, email: string, forUserId?: string): Promise<void> {
    const holder = await db.user.findUnique({ where: { email } });
    if (!holder || holder.id === forUserId) return;
    if (holder.emailVerifiedAt) {
      throw new ConflictException('Un compte existe déjà avec cette adresse e-mail.');
    }
    await db.user.update({ where: { id: holder.id }, data: { email: null } });
  }

  /** Crée un lien de vérification et l'envoie. Ne lève jamais d'exception ; renvoie false si l'e-mail n'est pas parti. */
  private async sendVerificationEmail(user: { id: string; email: string | null; fullName: string }): Promise<boolean> {
    if (!user.email) return false;
    try {
      const rawToken = randomBytes(32).toString('hex');
      await this.prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          email: user.email,
          tokenHash: this.hashToken(rawToken),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_VALIDITY_MS),
        },
      });
      const frontendUrl = this.configService.get('frontendUrl', { infer: true });
      const url = `${frontendUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
      return await this.mailService.send({
        to: { email: user.email, name: user.fullName },
        ...verificationEmail({ fullName: user.fullName, url }),
      });
    } catch (error) {
      this.logger.error(`Envoi du lien de vérification impossible : ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
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
      // Identifiant unique par jeton : sans lui, deux connexions du même compte dans la même seconde
      // donneraient deux jetons identiques, et la base (RefreshToken.tokenHash est unique) refuserait le second.
      jwtid: randomUUID(),
    });

    const refreshExpiresIn = this.configService.get('jwt.refreshExpiresIn', { infer: true });
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get('jwt.refreshSecret', { infer: true }),
      expiresIn: refreshExpiresIn as StringValue,
      jwtid: randomUUID(),
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
