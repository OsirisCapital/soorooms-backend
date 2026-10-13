import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export const DISPUTE_DECISIONS = ['REFUND_FULL', 'REFUND_PARTIAL', 'PAY_HOST'] as const;
export type DisputeDecision = (typeof DISPUTE_DECISIONS)[number];

export class ResolveDisputeDto {
  @IsIn([...DISPUTE_DECISIONS], { message: 'Décision inconnue.' })
  decision!: DisputeDecision;

  /** Montant rendu au voyageur (FCFA), uniquement pour REFUND_PARTIAL : strictement entre 0 et la somme payée. */
  @IsOptional()
  @IsInt()
  @Min(1)
  refundAmount?: number;

  /** Motif de la décision : conservé dans le journal et montré aux deux parties. */
  @IsString()
  @MinLength(10, { message: 'Expliquez la décision (10 caractères minimum).' })
  @MaxLength(500)
  note!: string;
}
