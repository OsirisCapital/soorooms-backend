import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const TICKET_CATEGORIES = ['ACCOUNT', 'BOOKING', 'PAYMENT', 'PROPERTY', 'TECHNICAL', 'OTHER'] as const;
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED'] as const;

export class CreateTicketDto {
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Donnez un objet à votre demande (5 caractères minimum).' })
  @MaxLength(120, { message: "L'objet est limité à 120 caractères." })
  subject!: string;

  @IsIn(TICKET_CATEGORIES, { message: 'Choisissez une catégorie.' })
  category!: (typeof TICKET_CATEGORIES)[number];

  @Transform(trim)
  @IsString()
  @MinLength(10, { message: 'Décrivez votre problème (10 caractères minimum).' })
  @MaxLength(4000, { message: 'Le message est limité à 4 000 caractères.' })
  message!: string;

  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class TicketReplyDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Écrivez votre message.' })
  @MaxLength(4000, { message: 'Le message est limité à 4 000 caractères.' })
  body!: string;
}

export class StaffReplyDto extends TicketReplyDto {
  /** Note interne : visible de l'équipe seulement. */
  @IsOptional()
  @IsBoolean()
  internal?: boolean;
}

export class AssignTicketDto {
  /** Identifiant du membre de l'équipe, ou null pour retirer l'assignation. */
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  assigneeId!: string | null;
}

export class SetTicketStatusDto {
  @IsEnum(TICKET_STATUSES as unknown as Record<string, string>, { message: 'Statut inconnu.' })
  status!: (typeof TICKET_STATUSES)[number];
}
