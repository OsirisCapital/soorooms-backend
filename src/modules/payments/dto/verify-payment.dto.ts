import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyPaymentDto {
  /** Référence du paiement au retour de la page de l'agrégateur. Jamais crue sur parole : le serveur
   *  la relit chez l'agrégateur et vérifie qu'elle désigne bien la réservation de l'URL. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  reference!: string;
}
