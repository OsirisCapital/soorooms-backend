import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PERMISSIONS } from '../../admin/permissions.js';
import { STAFF_ROLES } from '../staff.labels.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : trim({ value }));
const INTERNAL_PATH = /^\/(?!\/)[^\s\\]*$/;

export class UpdateStaffDto {
  @IsIn(STAFF_ROLES, { message: 'Choisissez un niveau.' })
  staffRole!: (typeof STAFF_ROLES)[number];

  /** Accès ajoutés au niveau. */
  @IsArray()
  @ArrayMaxSize(PERMISSIONS.length)
  @IsIn(PERMISSIONS, { each: true, message: 'Accès inconnu.' })
  permissions!: string[];
}

export class AddStaffDto extends UpdateStaffDto {
  /** E-mail ou téléphone du compte existant. */
  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Indiquez l’e-mail ou le téléphone du compte.' })
  @MaxLength(120)
  identifier!: string;
}

export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'] as const;

export class CreateTaskDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Le titre doit faire 3 caractères au moins.' })
  @MaxLength(120, { message: 'Le titre est limité à 120 caractères.' })
  title!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(1000, { message: 'Les détails sont limités à 1 000 caractères.' })
  details?: string;

  @IsUUID()
  assigneeId!: string;

  @IsIn(TASK_PRIORITIES, { message: 'Choisissez une priorité.' })
  priority!: (typeof TASK_PRIORITIES)[number];

  /** AAAA-MM-JJ. */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString({ strict: true }, { message: 'Date invalide.' })
  dueDate?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(INTERNAL_PATH, { message: 'Le lien doit être une page de l’application, par exemple /admin/support.' })
  @MaxLength(200)
  href?: string;
}

export class AssignTaskDto {
  @IsUUID()
  assigneeId!: string;
}

export class SetTaskStatusDto {
  @IsIn(TASK_STATUSES, { message: 'Statut inconnu.' })
  status!: (typeof TASK_STATUSES)[number];
}
