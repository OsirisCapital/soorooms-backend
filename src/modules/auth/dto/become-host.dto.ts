/**
 * Bascule un compte TRAVELER existant en HOST. Ne déclenche PAS le KYC —
 * le KYC n'est demandé qu'au moment où l'hôte tente de publier son premier
 * logement (voir kyc.service.ts et PropertiesService.publish). C'est la
 * friction zéro décidée : créer un compte hôte et une première annonce ne
 * doit jamais être bloqué par le KYC, seule la mise en ligne l'est.
 */
import { IsOptional, IsString } from 'class-validator';

export class BecomeHostDto {
  @IsOptional()
  @IsString()
  bio?: string;
}
