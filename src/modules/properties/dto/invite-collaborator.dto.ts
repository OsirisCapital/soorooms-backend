import { Transform } from 'class-transformer';
import { IsEnum, IsPhoneNumber } from 'class-validator';
import { normalizePhone } from '../../../common/utils/phone.js';
import { CollaboratorRole } from '../../../prisma/client.js';

export class InviteCollaboratorDto {
  // La personne invitée doit déjà avoir un compte SòôRooms (voir
  // PropertiesService.inviteCollaborator) — on ne crée pas de compte à sa
  // place, pour ne jamais assigner un mot de passe ou des droits à
  // l'insu de quelqu'un.
  @Transform(({ value }) => normalizePhone(value))
  @IsPhoneNumber('CM')
  phone!: string;

  @IsEnum(CollaboratorRole)
  role!: CollaboratorRole;
}
