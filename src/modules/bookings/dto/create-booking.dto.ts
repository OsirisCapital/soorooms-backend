import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Max, Min, MinLength } from 'class-validator';
import { EVENT_SLOTS, type EventSlot } from '../event.utils.js';

export class CreateBookingDto {
  @IsUUID()
  roomId!: string;

  @IsDateString()
  checkInDate!: string;

  // Facultatif pour une salle de fêtes (un événement = une date) ; exigé pour un séjour.
  @IsOptional()
  @IsDateString()
  checkOutDate?: string;

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

  // Réservation pour une autre personne : le compte connecté paie, l'occupant est identifié ici.
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  guestName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ]{6,20}$/, { message: 'Numéro de téléphone invalide.' })
  guestPhone?: string;

  // Salle de fêtes uniquement.
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  eventType?: string;

  @IsOptional()
  @IsIn(EVENT_SLOTS)
  eventSlot?: EventSlot;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  eventGuests?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  optionIds?: string[];
}
