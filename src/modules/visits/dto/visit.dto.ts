import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsObject, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';
import { MAX_VISIT_PHOTOS, MIN_VISIT_PHOTOS } from '../visit.utils.js';

export class AssignVisitDto {
  @IsUUID()
  agentId!: string;
}

export class SubmitVisitReportDto {
  /** true = logement conforme (badge accordé), false = points à corriger. */
  @IsBoolean()
  conforming!: boolean;

  /** Grille complète (clé → oui/non) : validée par parseChecklist. */
  @IsObject()
  checklist!: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(MIN_VISIT_PHOTOS)
  @ArrayMaxSize(MAX_VISIT_PHOTOS)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true, message: 'Chaque photo doit être un lien https.' })
  photoUrls!: string[];

  @Type(() => String)
  @IsString()
  @MaxLength(2000)
  report!: string;
}
