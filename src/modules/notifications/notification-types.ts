/**
 * Catalogue des notifications : pour chaque événement, le titre, le texte et la page vers laquelle
 * mène un appui. Tous les textes sont ici, au même endroit : les relire ou les corriger ne demande
 * pas de chercher dans les services métier. Fonctions pures, testées.
 */

/** Le même événement ne s'adresse pas pareil au voyageur et à l'hôte (et ne mène pas à la même page). */
export type Audience = 'traveler' | 'host';

export type NotificationPayloads = {
  // Identité
  KYC_SUBMITTED: { fullName: string }; // → équipe
  KYC_APPROVED: Record<string, never>;
  KYC_REJECTED: { reason: string };
  // Réservation et négociation
  BOOKING_REQUESTED: { bookingId: string; travelerName: string; propertyTitle: string; amount?: number }; // → hôte
  OFFER_RECEIVED: { bookingId: string; audience: Audience; amount: number; fromName: string };
  OFFER_ACCEPTED: { bookingId: string; audience: Audience; amount: number; propertyTitle: string };
  OFFER_REJECTED: { bookingId: string; audience: Audience; propertyTitle: string };
  // Paiement et séjour
  PAYMENT_CONFIRMED: { bookingId: string; audience: Audience; amount: number; propertyTitle: string };
  PAYMENT_FAILED: { bookingId: string; propertyTitle: string }; // → voyageur
  STAY_CONFIRMATION_REQUESTED: { bookingId: string; audience: Audience; otherName: string };
  BOOKING_COMPLETED: { bookingId: string; propertyTitle: string }; // → voyageur
  PAYOUT_RELEASED: { bookingId: string; amount: number; propertyTitle: string }; // → hôte
  DISPUTE_OPENED: { bookingId: string; audience: Audience };
  DISPUTE_OPENED_STAFF: { bookingId: string }; // → équipe
  // Logements
  PROPERTY_PUBLISHED: { propertyId: string; propertyTitle: string };
  PROPERTY_SUSPENDED: { propertyId: string; propertyTitle: string };
  // Support
  SUPPORT_TICKET_NEW: { ticketId: string; number: number; subject: string }; // → équipe
  SUPPORT_USER_REPLY: { ticketId: string; number: number; fromName: string }; // → équipe
  SUPPORT_REPLY: { ticketId: string; number: number }; // → utilisateur
  SUPPORT_TICKET_RESOLVED: { ticketId: string; number: number }; // → utilisateur
  // Équipe
  STAFF_ACCESS_CHANGED: { roleLabel: string | null }; // → membre concerné (null : retiré de l'équipe)
  TASK_ASSIGNED: { taskId: string; title: string; fromName: string; dueDate?: string }; // → assigné
  TASK_DONE: { taskId: string; title: string; byName: string }; // → créateur
  // Autres
  MESSAGE_RECEIVED: { fromName: string; bookingId?: string };
  ANNOUNCEMENT: { title: string; body: string; href?: string };
};

export type NotificationType = keyof NotificationPayloads;

export type RenderedNotification = { title: string; body: string; linkUrl: string | null };

const MAX_FREE_TEXT = 80;

/** Texte saisi par un utilisateur (nom, titre d'annonce…) : borné, sur une seule ligne. */
export function clip(text: string, max = MAX_FREE_TEXT): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 15000 → « 15 000 FCFA » (espace ordinaire : s'affiche pareil partout). */
export function fcfa(amount: number): string {
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

/** Numéro lisible donné à l'utilisateur : 42 → « SR-0042 ». */
export function ticketRef(number: number): string {
  return `SR-${String(number).padStart(4, '0')}`;
}

export function bookingLink(audience: Audience, bookingId: string): string {
  return audience === 'host' ? `/hote/reservations/${bookingId}` : `/profil/reservations/${bookingId}`;
}

/** Une adresse de redirection n'est acceptée que si elle reste dans l'application. */
export function isInternalPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && value.length <= 200;
}

type Renderers = { [K in NotificationType]: (p: NotificationPayloads[K]) => RenderedNotification };

const RENDERERS: Renderers = {
  KYC_SUBMITTED: (p) => ({
    title: "Nouvelle demande d'identité",
    body: `${clip(p.fullName)} attend la vérification de son identité.`,
    linkUrl: '/admin/accreditations',
  }),
  KYC_APPROVED: () => ({
    title: 'Identité vérifiée ✓',
    body: 'Votre compte est vérifié. Vous pouvez maintenant publier vos logements.',
    linkUrl: '/hote',
  }),
  KYC_REJECTED: (p) => ({
    title: "Vérification d'identité refusée",
    body: `Motif : ${clip(p.reason, 160)}. Vous pouvez renvoyer vos documents.`,
    linkUrl: '/profil/parametres/hote',
  }),
  BOOKING_REQUESTED: (p) => ({
    title: 'Nouvelle demande de réservation',
    body: `${clip(p.travelerName)} souhaite réserver « ${clip(p.propertyTitle)} ».${p.amount ? ` Prix proposé : ${fcfa(p.amount)}.` : ''}`,
    linkUrl: bookingLink('host', p.bookingId),
  }),
  OFFER_RECEIVED: (p) => ({
    title: 'Nouvelle proposition de prix',
    body: `${clip(p.fromName)} propose ${fcfa(p.amount)}. Acceptez ou faites une contre-proposition.`,
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  OFFER_ACCEPTED: (p) => ({
    title: 'Prix accepté 🤝',
    body:
      p.audience === 'traveler'
        ? `Le prix de ${fcfa(p.amount)} pour « ${clip(p.propertyTitle)} » est validé. Vous pouvez payer.`
        : `Le prix de ${fcfa(p.amount)} pour « ${clip(p.propertyTitle)} » est validé. Le voyageur va payer.`,
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  OFFER_REJECTED: (p) => ({
    title: 'Négociation terminée',
    body: `La demande pour « ${clip(p.propertyTitle)} » a été refusée : la réservation est annulée.`,
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  PAYMENT_CONFIRMED: (p) => ({
    title: p.audience === 'traveler' ? 'Paiement reçu ✓' : 'Paiement sécurisé ✓',
    body:
      p.audience === 'traveler'
        ? `Votre paiement de ${fcfa(p.amount)} pour « ${clip(p.propertyTitle)} » est confirmé. Les fonds sont gardés en sécurité jusqu'à votre séjour.`
        : `Le voyageur a payé ${fcfa(p.amount)} pour « ${clip(p.propertyTitle)} ». Les fonds sont sécurisés : vous pouvez l'accueillir.`,
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  PAYMENT_FAILED: (p) => ({
    title: 'Paiement non abouti',
    body: `Le paiement pour « ${clip(p.propertyTitle)} » n'a pas abouti. Vous pouvez réessayer.`,
    linkUrl: bookingLink('traveler', p.bookingId),
  }),
  STAY_CONFIRMATION_REQUESTED: (p) => ({
    title: 'Votre confirmation est attendue',
    body:
      p.audience === 'host'
        ? `${clip(p.otherName)} a confirmé son arrivée. Confirmez l'accueil pour déclencher votre versement.`
        : `${clip(p.otherName)} a confirmé l'accueil. Confirmez votre arrivée pour terminer la réservation.`,
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  BOOKING_COMPLETED: (p) => ({
    title: 'Séjour terminé',
    body: `Merci d'avoir séjourné à « ${clip(p.propertyTitle)} ». Laissez un avis pour aider les autres voyageurs.`,
    linkUrl: bookingLink('traveler', p.bookingId),
  }),
  PAYOUT_RELEASED: (p) => ({
    title: 'Versement déclenché 💸',
    body: `${fcfa(p.amount)} vous sont versés pour « ${clip(p.propertyTitle)} ».`,
    linkUrl: bookingLink('host', p.bookingId),
  }),
  DISPUTE_OPENED: (p) => ({
    title: 'Un litige a été ouvert',
    body: "Les fonds restent bloqués le temps que l'équipe SòôRooms examine la situation.",
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  DISPUTE_OPENED_STAFF: () => ({
    title: 'Nouveau litige à traiter',
    body: 'Une réservation vient d’être contestée.',
    linkUrl: '/admin/litiges',
  }),
  PROPERTY_PUBLISHED: (p) => ({
    title: 'Logement publié 🎉',
    body: `« ${clip(p.propertyTitle)} » est maintenant visible par les voyageurs.`,
    linkUrl: `/hote/logements/${p.propertyId}`,
  }),
  PROPERTY_SUSPENDED: (p) => ({
    title: 'Logement suspendu',
    body: `« ${clip(p.propertyTitle)} » n'est plus visible. Contactez le support pour en savoir plus.`,
    linkUrl: `/hote/logements/${p.propertyId}`,
  }),
  SUPPORT_TICKET_NEW: (p) => ({
    title: 'Nouvelle demande au support',
    body: `${ticketRef(p.number)} : ${clip(p.subject, 100)}`,
    linkUrl: `/admin/support/${p.ticketId}`,
  }),
  SUPPORT_USER_REPLY: (p) => ({
    title: 'Réponse sur une demande',
    body: `${clip(p.fromName)} a répondu à ${ticketRef(p.number)}.`,
    linkUrl: `/admin/support/${p.ticketId}`,
  }),
  SUPPORT_REPLY: (p) => ({
    title: 'Le support vous a répondu',
    body: `Votre demande ${ticketRef(p.number)} a une nouvelle réponse.`,
    linkUrl: `/profil/aide/tickets/${p.ticketId}`,
  }),
  SUPPORT_TICKET_RESOLVED: (p) => ({
    title: 'Demande résolue ✓',
    body: `Votre demande ${ticketRef(p.number)} est marquée comme résolue. Répondez-y si le problème persiste.`,
    linkUrl: `/profil/aide/tickets/${p.ticketId}`,
  }),
  STAFF_ACCESS_CHANGED: (p) => ({
    title: p.roleLabel ? 'Vos accès ont changé' : 'Vous ne faites plus partie de l’équipe',
    body: p.roleLabel
      ? `Votre niveau dans l'équipe SòôRooms est maintenant : ${clip(p.roleLabel, 60)}. Reconnectez-vous pour que tout soit à jour.`
      : "Vos accès à l'administration ont été retirés. Votre compte reste utilisable comme voyageur ou hôte.",
    linkUrl: p.roleLabel ? '/admin' : '/profil',
  }),
  TASK_ASSIGNED: (p) => ({
    title: 'Nouvelle tâche pour vous',
    body: `${clip(p.fromName, 60)} vous a confié : ${clip(p.title, 120)}${p.dueDate ? ` (pour le ${p.dueDate})` : ''}.`,
    linkUrl: '/admin/taches',
  }),
  TASK_DONE: (p) => ({
    title: 'Tâche terminée ✓',
    body: `${clip(p.byName, 60)} a terminé : ${clip(p.title, 120)}.`,
    linkUrl: '/admin/taches',
  }),
  MESSAGE_RECEIVED: (p) => ({
    title: 'Nouveau message',
    body: `${clip(p.fromName)} vous a écrit.`,
    linkUrl: p.bookingId ? `/messages/${encodeURIComponent(p.bookingId)}` : '/messages',
  }),
  ANNOUNCEMENT: (p) => ({
    title: clip(p.title, 100),
    body: clip(p.body, 300),
    linkUrl: isInternalPath(p.href) ? p.href : null,
  }),
};

export function renderNotification<T extends NotificationType>(type: T, payload: NotificationPayloads[T]): RenderedNotification {
  return (RENDERERS[type] as (p: NotificationPayloads[T]) => RenderedNotification)(payload);
}
