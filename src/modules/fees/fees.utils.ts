/**
 * Calcul des commissions et frais. Fonctions pures : aucune lecture en base.
 *
 * Un séjour de 30 000 FCFA avec commission hôte 5 % et frais voyageur 3 % donne :
 *   le voyageur paie     30 000 + 900 = 30 900   (amountHeld)
 *   l'hôte reçoit        30 000 - 1 500 = 28 500 (hostPayout)
 *   la plateforme garde  1 500 + 900 = 2 400     (platformFee)
 * et toujours : amountHeld = hostPayout + platformFee (aucun franc ne se perd).
 */
export type FeeSettings = {
  hostCommissionPercent: number;
  launchHostCommissionPercent: number | null;
  launchEndsAt: Date | null;
  travelerFeePercent: number;
};

export type AppliedRates = { hostCommissionPercent: number; travelerFeePercent: number; launchActive: boolean };

/** L'offre de lancement s'applique tant que sa date de fin n'est pas passée. */
export function ratesAt(settings: FeeSettings, now: Date): AppliedRates {
  const launchActive =
    settings.launchHostCommissionPercent != null && settings.launchEndsAt != null && settings.launchEndsAt.getTime() > now.getTime();
  return {
    hostCommissionPercent: launchActive ? (settings.launchHostCommissionPercent as number) : settings.hostCommissionPercent,
    travelerFeePercent: settings.travelerFeePercent,
    launchActive,
  };
}

export type Amounts = {
  amountHeld: number;
  platformFee: number;
  hostPayout: number;
  hostCommission: number;
  travelerFee: number;
};

const part = (total: number, percent: number) => Math.round((total * percent) / 100);

export function computeAmounts(stayPrice: number, rates: Pick<AppliedRates, 'hostCommissionPercent' | 'travelerFeePercent'>): Amounts {
  const hostCommission = part(stayPrice, rates.hostCommissionPercent);
  const travelerFee = part(stayPrice, rates.travelerFeePercent);
  return {
    amountHeld: stayPrice + travelerFee,
    platformFee: hostCommission + travelerFee,
    hostPayout: stayPrice - hostCommission,
    hostCommission,
    travelerFee,
  };
}

export const MAX_HOST_PERCENT = 30;
export const MAX_TRAVELER_PERCENT = 15;
