/**
 * Extras payants d'un séjour (navette aéroport, petit-déjeuner, ménage…). L'hôte les définit par logement ;
 * la réservation en garde une copie figée, comme pour les options d'une salle.
 *
 * Un extra est facturé une seule fois, ou chaque nuit (`perNight`) pour toute la réservation — il n'est pas
 * multiplié par le nombre de chambres : l'hôte fixe le prix en conséquence.
 */
export type ExtraSnapshot = {
  id: string;
  name: string;
  price: number;
  perNight: boolean;
};

export function extrasTotal(extras: ReadonlyArray<{ price: number; perNight: boolean }>, nights: number): number {
  const n = Math.max(1, nights);
  return extras.reduce((sum, e) => sum + e.price * (e.perNight ? n : 1), 0);
}
