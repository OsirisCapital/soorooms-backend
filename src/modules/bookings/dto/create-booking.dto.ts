import { IsDateString, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CreateBookingDto {
  @IsUUID()
  roomId!: string;

  @IsDateString()
  checkInDate!: string;

  @IsDateString()
  checkOutDate!: string;

  // Optionnel : si omis, le service propose automatiquement le prix de
  // base de la chambre pour la durée demandée — ça couvre aussi bien le
  // voyageur qui veut réserver directement au tarif affiché que celui qui
  // veut ouvrir une négociation avec un montant différent. Dans les deux
  // cas, l'hôte doit valider explicitement (voir BookingsService.accept).
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(99_999_999)
  proposedPrice?: number;
}
