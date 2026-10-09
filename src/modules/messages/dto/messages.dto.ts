import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Écrivez votre message.' })
  @MaxLength(2000, { message: 'Le message est limité à 2 000 caractères.' })
  content!: string;
}
