import { IsOptional, IsInt, IsUrl, Min } from 'class-validator';

export class AddPhotoDto {
  @IsUrl({}, { message: 'url doit être une URL valide.' })
  url!: string;

  // Position dans le carrousel — si omise, la photo est ajoutée à la fin.
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
