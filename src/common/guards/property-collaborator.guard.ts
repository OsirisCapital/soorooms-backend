/**
 * Vérifie que l'utilisateur courant est bien collaborateur (MANAGER ou
 * AGENT) de la Property visée par la route (ex: PATCH /properties/:id).
 * C'est ce qui empêche concrètement un hôte de modifier la fiche d'un
 * établissement qui n'est pas le sien en devinant simplement son UUID —
 * la simple appartenance à PropertyCollaborator ne suffit pas sans cette
 * vérification explicite à chaque requête.
 *
 * @RequireCollaboratorRole('MANAGER') restreint en plus certaines actions
 * (achat de boost, changement de prix) au rôle MANAGER uniquement.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CollaboratorRole } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { COLLABORATOR_ROLE_KEY } from '../decorators/require-collaborator-role.decorator.js';

@Injectable()
export class PropertyCollaboratorGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const propertyId: string | undefined = request.params?.propertyId ?? request.params?.id;
    const userId: string | undefined = request.user?.id;

    if (!propertyId || !userId) {
      throw new ForbiddenException('Contexte insuffisant pour vérifier les droits sur ce logement.');
    }

    const collaboration = await this.prisma.propertyCollaborator.findUnique({
      where: { userId_propertyId: { userId, propertyId } },
    });

    if (!collaboration) {
      throw new ForbiddenException("Vous n'êtes pas gestionnaire de ce logement.");
    }

    const requiredRole = this.reflector.getAllAndOverride<CollaboratorRole | undefined>(
      COLLABORATOR_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredRole && collaboration.role !== requiredRole) {
      throw new ForbiddenException(`Cette action est réservée au rôle ${requiredRole} de ce logement.`);
    }

    // Rendu disponible aux services suivants sans nouvelle requête DB.
    request.collaboration = collaboration;
    return true;
  }
}
