/** Réservation d'une salle de fêtes : une salle = un événement par date, avec créneau, invités et options. */
export const EVENT_SLOTS = ['DAY', 'EVENING', 'FULL'] as const;
export type EventSlot = (typeof EVENT_SLOTS)[number];

export const EVENT_SLOT_LABEL: Record<EventSlot, string> = {
  DAY: 'Journée',
  EVENING: 'Soirée',
  FULL: '24 h (jour et soir)',
};

export type EventOptionSnapshot = {
  id: string;
  name: string;
  price: number;
}

/** Prix proposé par défaut : tarif de la salle pour la date + options choisies. */
export function eventDefaultPrice(basePrice: unknown, options: ReadonlyArray<{ price: unknown }>): number {
  return Number(basePrice) + options.reduce((sum, o) => sum + Number(o.price), 0);
}

/** Message d'erreur si le nombre d'invités dépasse la capacité, sinon null. */
export function guestsError(guests: number, capacity: number): string | null {
  return guests > capacity ? `Cette salle accueille ${capacity} personne${capacity > 1 ? 's' : ''} au maximum.` : null;
}
