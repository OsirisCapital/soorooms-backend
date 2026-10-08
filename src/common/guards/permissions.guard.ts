/**
 * Vérifie les accès fins de l'équipe. S'exécute après JwtAuthGuard et RolesGuard (globaux) : ici on
 * sait déjà que la personne est connectée et ADMIN. Les accès sont relus en base à chaque appel, pas
 * dans le jeton : retirer un accès à quelqu'un prend effet tout de suite, pas à l'expiration de sa session.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { permissionsFor, type Permission } from '../../modules/admin/permissions.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PERMISSIONS_KEY, STAFF_ONLY_KEY } from '../decorators/permissions.decorator.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    const staffOnly = this.reflector.getAllAndOverride<boolean | undefined>(STAFF_ONLY_KEY, targets);

    // Route d'administration sans accès déclaré : refusée par défaut.
    if (!staffOnly && (!required || required.length === 0)) {
      throw new ForbiddenException("Accès non défini pour cette route d'administration.");
    }

    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.id;
    const account = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, staffRole: true, staffPermissions: true },
        })
      : null;
    if (!account || account.role !== 'ADMIN') {
      throw new ForbiddenException("Cet espace est réservé à l'équipe d'administration.");
    }

    const granted = permissionsFor(account);
    if (required?.length && !required.every((permission) => granted.includes(permission))) {
      throw new ForbiddenException("Vous n'avez pas l'accès nécessaire pour cette action.");
    }
    return true;
  }
}
