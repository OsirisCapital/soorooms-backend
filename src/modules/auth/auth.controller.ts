/**
 * Expose l'authentification : inscription, connexion, refresh, déconnexion,
 * bascule hôte, et le flux OAuth Google (redirection + callback).
 *
 * Rate limiting resserré (@Throttle) sur register/login : ce sont les
 * cibles naturelles du brute-force et du credential stuffing, la limite
 * globale de 60 req/min (voir app.module.ts) est trop permissive pour elles
 * spécifiquement.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import type { AppConfig } from '../../config/configuration.js';
import { AuthService } from './auth.service.js';
import { BecomeHostDto } from './dto/become-host.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { SetEmailDto } from './dto/set-email.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { GoogleAuthGuard, GoogleLoginGuard } from './guards/google-auth.guard.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.validateCredentials(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // Ouvert à tous : le lien reçu par e-mail s'ouvre souvent sur un autre appareil que celui de l'inscription.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  resendVerification(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.resendVerification(user.id);
  }

  // Ajoute ou remplace l'adresse e-mail du compte. Exige le mot de passe actuel, d'où une limite stricte.
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @HttpCode(HttpStatus.OK)
  @Put('email')
  setEmail(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetEmailDto) {
    return this.authService.setEmail(user.id, dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Sans @ApiBearerAuth() ici, Swagger UI n'attache pas l'en-tête
  // Authorization à la requête même après avoir cliqué "Authorize" — ce
  // décorateur déclare, route par route, que celle-ci exige le schéma
  // "bearer" défini dans main.ts.
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.authService.logout(user.id);
  }

  // Profil du compte connecté : sert au client pour afficher le nom, savoir
  // s'il peut basculer en mode hôte (rôle + KYC), etc. Le rôle et le statut
  // KYC sont lus en base à chaque appel : le rôle du token, lui, reste celui
  // du moment de la connexion.
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.id);
  }

  @ApiBearerAuth()
  @Post('become-host')
  becomeHost(@CurrentUser() user: AuthenticatedUser, @Body() dto: BecomeHostDto) {
    return this.authService.becomeHost(user.id, dto);
  }

  // --- Flux OAuth Google ---------------------------------------------------

  @Public()
  @Get('google')
  @UseGuards(GoogleLoginGuard)
  googleAuth() {
    // Le guard redirige vers Google ; ce corps ne s'exécute jamais.
  }

  // Retour de Google : le navigateur de l'utilisateur arrive ici, pas le
  // frontend — on ne peut donc pas répondre en JSON. On le redirige vers le
  // frontend avec les tokens dans le fragment de l'URL (#…), que le navigateur
  // n'envoie jamais à un serveur et qui n'apparaît pas dans les journaux.
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.configService.get('frontendUrl', { infer: true });

    // Annulation chez Google ou échec de l'échange (voir GoogleAuthGuard).
    if (!req.user) {
      return res.redirect(`${frontendUrl}/login?error=google`);
    }

    try {
      // req.user vient de GoogleStrategy.validate() — voir strategies/google.strategy.ts
      const tokens = await this.authService.loginWithGoogle(req.user as never);
      const fragment = new URLSearchParams({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      return res.redirect(`${frontendUrl}/auth/callback#${fragment.toString()}`);
    } catch {
      return res.redirect(`${frontendUrl}/login?error=google`);
    }
  }
}
