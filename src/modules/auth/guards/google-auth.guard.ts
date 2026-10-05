/**
 * Gardes Google OAuth.
 *
 * POURQUOI PAS « class X extends AuthGuard('google') » : une sous-classe sans
 * constructeur n'a aucune métadonnée `design:paramtypes` propre. Nest retombe
 * alors sur le constructeur interne du mixin de @nestjs/passport, qui demande
 * `AuthModuleOptions`, et plante au démarrage avec « Nest can't resolve
 * dependencies of the GoogleAuthGuard (?) ».
 *
 * Ici on délègue à une instance créée à la main : aucune injection de
 * dépendances n'est nécessaire, donc plus aucune résolution possible à rater.
 * (`AuthModuleOptions` est facultatif dans le mixin — `new` sans argument est
 * exactement ce que fait Nest quand PassportModule n'est pas importé.)
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

const PassportGoogleGuard = AuthGuard('google');

/** Départ du flux : /auth/google redirige l'utilisateur vers Google. */
@Injectable()
export class GoogleLoginGuard implements CanActivate {
  private readonly inner = new PassportGoogleGuard();

  canActivate(context: ExecutionContext) {
    return this.inner.canActivate(context);
  }
}

/**
 * Retour de Google (/auth/google/callback). Par défaut, passport répond par
 * une erreur 401 JSON brute quand l'utilisateur annule chez Google ou que
 * l'échange échoue — peu lisible dans un navigateur. Ici on laisse passer la
 * requête avec `req.user` vide, et le contrôleur renvoie l'utilisateur vers la
 * page de connexion avec un message.
 */
@Injectable()
export class GoogleAuthGuard implements CanActivate {
  private readonly inner = new PassportGoogleGuard();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await this.inner.canActivate(context);
    } catch {
      // Annulation ou échec : req.user reste indéfini, voir AuthController.
    }
    return true;
  }
}
