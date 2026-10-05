import { IsString, MinLength } from 'class-validator';

export class RaiseDisputeDto {
  @IsString()
  @MinLength(10, { message: 'Décrivez le problème rencontré (10 caractères minimum).' })
  reason!: string;
}
