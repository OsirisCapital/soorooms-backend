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
  ATTESTATION_REQUESTED: { bookingId: string; travelerName: string; propertyTitle: string }; // → gérants
  ATTESTATION_SIGNED: { bookingId: string; propertyTitle: string }; // → voyageur
  ATTESTATION_DECLINED: { bookingId: string; propertyTitle: string; reason: string }; // → voyageur
  BOOKING_EXPIRED: { bookingId: string; audience: Audience; propertyTitle: string }; // demande sans réponse sous 2 h
  // Paiement et séjour
  PAYMENT_CONFIRMED: { bookingId: string; audience: Audience; amount: number; propertyTitle: string };
  PAYMENT_FAILED: { bookingId: string; propertyTitle: string }; // → voyageur
  BALANCE_FORFEITED: { bookingId: string; audience: Audience; propertyTitle: string; amount: number }; // solde non payé à l'échéance : l'acompte reste à l'hôte
  STAY_CONFIRMATION_REQUESTED: { bookingId: string; audience: Audience; otherName: string };
  BOOKING_COMPLETED: { bookingId: string; propertyTitle: string }; // → voyageur
  PAYOUT_QUEUED: { bookingId: string; amount: number; propertyTitle: string; needsDetails: boolean }; // → hôte
  PAYOUT_RELEASED: { bookingId: string; amount: number; propertyTitle: string }; // → hôte
  PAYOUT_TO_SEND_STAFF: { amount: number; propertyTitle: string }; // → finance
  PAYOUT_FAILED_STAFF: { amount: number; propertyTitle: string }; // → finance
  BOOKING_CANCELLED: { bookingId: string; audience: Audience; propertyTitle: string; by: 'traveler' | 'host'; refundAmount: number };
  REFUND_TO_SEND_STAFF: { amount: number; propertyTitle: string }; // → finance
  REFUND_FAILED_STAFF: { amount: number; propertyTitle: string }; // → finance
  REFUND_SENT: { bookingId: string; amount: number; propertyTitle: string }; // → voyageur
  DISPUTE_OPENED: { bookingId: string; audience: Audience };
  DISPUTE_OPENED_STAFF: { bookingId: string }; // → équipe
  // Logements
  PROPERTY_PUBLISHED: { propertyId: string; propertyTitle: string };
  PROPERTY_SUSPENDED: { propertyId: string; propertyTitle: string };
  // Visites de vérification
  VISIT_PAID: { propertyId: string; propertyTitle: string }; // → gérants
  VISIT_PAID_STAFF: { propertyTitle: string }; // → équipe des visites
  VISIT_ASSIGNED: { visitId: string; propertyTitle: string; city: string }; // → agent
  VISIT_DONE: { propertyId: string; propertyTitle: string; conforming: boolean }; // → gérants
  // Équipe d'un logement
  TEAM_ADDED: { propertyId: string; propertyTitle: string; roleLabel: string }; // → la personne ajoutée
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
  FEES_CHANGED_STAFF: { hostPercent: number; travelerPercent: number }; // → équipe réglages
  FEES_CHANGED_HOST: { hostPercent: number; standardPercent: number; launchEndsAt?: string }; // → hôtes
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

/** 5 → « 5 % », 2.5 → « 2,5 % ». */
export function pct(value: number): string {
  return `${String(value).replace('.', ',')} %`;
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
  ATTESTATION_REQUESTED: (p) => ({
    title: 'Attestation de réservation demandée',
    body: `${clip(p.travelerName)} demande l’attestation de sa réservation à « ${clip(p.propertyTitle)} ». Ouvrez la réservation pour la signer.`,
    linkUrl: bookingLink('host', p.bookingId),
  }),
  ATTESTATION_DECLINED: (p) => ({
    title: 'Attestation refusée',
    body: `L’hôte de « ${clip(p.propertyTitle)} » n’a pas signé l’attestation. Motif : ${clip(p.reason, 160)}. Votre reçu reste disponible.`,
    linkUrl: bookingLink('traveler', p.bookingId),
  }),
  ATTESTATION_SIGNED: (p) => ({
    title: 'Attestation signée ✓',
    body: `Votre attestation de réservation pour « ${clip(p.propertyTitle)} » est prête : vous pouvez la télécharger.`,
    linkUrl: bookingLink('traveler', p.bookingId),
  }),
  BOOKING_EXPIRED: (p) => ({
    title: 'Demande expirée',
    body:
      p.audience === 'traveler'
        ? `Personne n’a répondu dans les 2 heures pour « ${clip(p.propertyTitle)} » : la demande est annulée, vous pouvez en envoyer une autre.`
        : `Une demande pour « ${clip(p.propertyTitle)} » a expiré faute de réponse dans les 2 heures.`,
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
  BALANCE_FORFEITED: (p) => ({
    title: p.audience === 'traveler' ? 'Réservation annulée : solde non payé' : 'Solde non payé : acompte conservé',
    body:
      p.audience === 'traveler'
        ? `Le solde de « ${clip(p.propertyTitle)} » n'a pas été payé à l'échéance : la réservation est annulée et l'acompte de ${fcfa(p.amount)} reste à l'hôte.`
        : `Le solde de « ${clip(p.propertyTitle)} » n'a pas été payé à l'échéance : la réservation est annulée. L'acompte de ${fcfa(p.amount)} vous sera versé.`,
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
  PAYOUT_QUEUED: (p) => ({
    title: 'Versement en préparation',
    body: p.needsDetails
      ? `${fcfa(p.amount)} vous seront versés pour « ${clip(p.propertyTitle)} ». Indiquez votre numéro Mobile Money pour les recevoir.`
      : `${fcfa(p.amount)} vous seront versés pour « ${clip(p.propertyTitle)} » après vérification par notre équipe.`,
    linkUrl: p.needsDetails ? '/profil/parametres/versement' : bookingLink('host', p.bookingId),
  }),
  PAYOUT_RELEASED: (p) => ({
    title: 'Versement envoyé 💸',
    body: `${fcfa(p.amount)} ont été envoyés sur votre compte Mobile Money pour « ${clip(p.propertyTitle)} ».`,
    linkUrl: bookingLink('host', p.bookingId),
  }),
  PAYOUT_TO_SEND_STAFF: (p) => ({
    title: 'Versement à envoyer',
    body: `${fcfa(p.amount)} à verser à l'hôte de « ${clip(p.propertyTitle)} ».`,
    linkUrl: '/admin/versements',
  }),
  PAYOUT_FAILED_STAFF: (p) => ({
    title: 'Versement en échec',
    body: `Le versement de ${fcfa(p.amount)} pour « ${clip(p.propertyTitle)} » a échoué. Ouvrez la file pour réessayer.`,
    linkUrl: '/admin/versements',
  }),
  BOOKING_CANCELLED: (p) => ({
    title: 'Réservation annulée',
    body:
      p.audience === 'host'
        ? p.by === 'host'
          ? `Vous avez annulé la réservation de « ${clip(p.propertyTitle)} ». Le voyageur sera remboursé.`
          : `Le voyageur a annulé sa réservation de « ${clip(p.propertyTitle)} ». Les dates sont de nouveau libres.`
        : p.by === 'host'
          ? `L'hôte a annulé votre réservation de « ${clip(p.propertyTitle)} ». ${fcfa(p.refundAmount)} vous seront remboursés après vérification par notre équipe.`
          : p.refundAmount > 0
            ? `Votre réservation de « ${clip(p.propertyTitle)} » est annulée. ${fcfa(p.refundAmount)} vous seront remboursés après vérification par notre équipe.`
            : `Votre réservation de « ${clip(p.propertyTitle)} » est annulée. Selon la politique de remboursement, aucun montant n'est à rembourser.`,
    linkUrl: bookingLink(p.audience, p.bookingId),
  }),
  REFUND_TO_SEND_STAFF: (p) => ({
    title: 'Remboursement à envoyer',
    body: `${fcfa(p.amount)} à rembourser au voyageur de « ${clip(p.propertyTitle)} ».`,
    linkUrl: '/admin/remboursements',
  }),
  REFUND_FAILED_STAFF: (p) => ({
    title: 'Remboursement en échec',
    body: `Le remboursement de ${fcfa(p.amount)} pour « ${clip(p.propertyTitle)} » a échoué. Ouvrez la file pour réessayer.`,
    linkUrl: '/admin/remboursements',
  }),
  REFUND_SENT: (p) => ({
    title: 'Remboursement envoyé 💸',
    body: `${fcfa(p.amount)} ont été envoyés sur votre compte Mobile Money pour « ${clip(p.propertyTitle)} ».`,
    linkUrl: bookingLink('traveler', p.bookingId),
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
  VISIT_PAID: (p) => ({
    title: 'Visite de vérification payée ✓',
    body: `Votre paiement est reçu pour « ${clip(p.propertyTitle)} ». Nous allons confier la visite à un agent.`,
    linkUrl: `/hote/logements/${encodeURIComponent(p.propertyId)}/verification`,
  }),
  VISIT_PAID_STAFF: (p) => ({
    title: 'Visite à assigner',
    body: `Une visite de vérification est payée pour « ${clip(p.propertyTitle)} » : choisissez un agent.`,
    linkUrl: '/admin/visites',
  }),
  VISIT_ASSIGNED: (p) => ({
    title: 'Nouvelle visite à réaliser',
    body: `Visite de vérification de « ${clip(p.propertyTitle)} » à ${clip(p.city, 40)}.`,
    linkUrl: `/admin/mes-visites/${encodeURIComponent(p.visitId)}`,
  }),
  VISIT_DONE: (p) => ({
    title: p.conforming ? 'Logement vérifié ✓' : 'Visite terminée : points à corriger',
    body: p.conforming
      ? `« ${clip(p.propertyTitle)} » porte désormais le badge « Vérifié par SòôRooms ».`
      : `La visite de « ${clip(p.propertyTitle)} » a relevé des points à corriger. Ouvrez le rapport pour les voir.`,
    linkUrl: `/hote/logements/${encodeURIComponent(p.propertyId)}/verification`,
  }),
  TEAM_ADDED: (p) => ({
    title: 'Vous rejoignez une équipe',
    body: `Vous avez été ajouté à « ${clip(p.propertyTitle)} » en tant que ${clip(p.roleLabel, 40)}.`,
    linkUrl: '/hote',
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
  FEES_CHANGED_STAFF: (p) => ({
    title: 'Commissions et frais modifiés',
    body: `Commission hôte ${pct(p.hostPercent)}, frais voyageur ${pct(p.travelerPercent)}.`,
    linkUrl: '/admin/frais',
  }),
  FEES_CHANGED_HOST: (p) => ({
    title: 'Votre commission change',
    body: p.launchEndsAt
      ? `Commission SòôRooms : ${pct(p.hostPercent)} (offre de lancement) jusqu'au ${p.launchEndsAt}, puis ${pct(p.standardPercent)}.`
      : `Commission SòôRooms : ${pct(p.hostPercent)} sur vos prochaines réservations.`,
    linkUrl: '/hote/finances',
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
