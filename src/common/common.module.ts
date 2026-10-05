/**
 * Regroupe les guards transversaux qui dépendent d'autres providers
 * (PropertyCollaboratorGuard a besoin de PrismaService) et doivent donc
 * être résolus par l'injecteur Nest plutôt qu'instanciés à la main. Tout
 * module qui utilise @UseGuards(PropertyCollaboratorGuard) importe ce
 * module — sinon Nest ne sait pas où résoudre ses dépendances.
 */
import { Module } from '@nestjs/common';
import { PropertyCollaboratorGuard } from './guards/property-collaborator.guard.js';

@Module({
  providers: [PropertyCollaboratorGuard],
  exports: [PropertyCollaboratorGuard],
})
export class CommonModule {}
