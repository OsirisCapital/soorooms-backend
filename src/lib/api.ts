/**
 * Client minimal pour l'API SòôRooms (backend NestJS). Toutes les réponses
 * du backend sont enveloppées sous { data, timestamp } par son
 * TransformInterceptor — ce client déballe systématiquement `.data` pour
 * que le reste du code manipule directement la forme utile.
 */
import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from "./auth-storage";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Le serveur n'a pas pu répondre (par opposition à « il a répondu et a refusé »).
 * Vrai pour une erreur réseau (le navigateur n'a obtenu aucune réponse exploitable, typique d'un
 * backend gratuit qui se réveille) et pour les erreurs 502/503/504 d'un intermédiaire.
 */
export function isServerUnavailable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 502;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    // Le backend renvoie { message: { message, error, statusCode } } pour
    // les erreurs de validation, ou { message: { message: string[] } }
    // pour class-validator — on essaie les deux formes raisonnablement.
    const rawMessage = body?.message?.message ?? body?.message ?? "Une erreur est survenue.";
    const message = Array.isArray(rawMessage) ? rawMessage.join(" ") : rawMessage;
    throw new ApiError(message, response.status);
  }

  return (body?.data ?? body) as T;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterPayload {
  fullName: string;
  phone: string;
  email: string;
  password: string;
}

export interface LoginPayload {
  phone: string;
  password: string;
}

export function registerUser(payload: RegisterPayload) {
  return request<AuthTokens>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function loginUser(payload: LoginPayload) {
  return request<AuthTokens>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Déconnexion côté serveur (révoque les refresh tokens). Best-effort : si le
 * réseau est coupé on se déconnecte quand même localement (voir profil/page).
 */
export async function logoutUser(): Promise<void> {
  try {
    await authRequest<null>("/auth/logout", { method: "POST" });
  } catch {
    // Le nettoyage local des tokens suffit à l'utilisateur ; ne pas bloquer.
  }
}

export function googleAuthUrl() {
  return `${API_URL}/auth/google`;
}

// ---------------------------------------------------------------------
// Recherche publique de logements — GET /search/rooms (aucun token requis)
// ---------------------------------------------------------------------

export type PropertyType = "HOTEL" | "FURNISHED_APARTMENT" | "STUDENT_ROOM" | "GUEST_HOUSE";

export interface SearchRoomsParams {
  city?: string;
  quarter?: string;
  checkInDate?: string; // YYYY-MM-DD — à fournir avec checkOutDate
  checkOutDate?: string;
  minPrice?: number;
  maxPrice?: number;
  propertyType?: PropertyType;
  maxGuests?: number;
  hasWifi?: boolean;
  hasGeneratorOrSolar?: boolean;
  hasAc?: boolean;
  hasParking?: boolean;
  /** « verified » : logements vérifiés sur place en tête ; défaut : moins cher d'abord. */
  sort?: "price" | "verified";
  page?: number;
  limit?: number;
}

/**
 * Forme renvoyée par le backend : une Room avec son Property (et les
 * équipements). Prisma sérialise les Decimal en chaînes, d'où
 * `basePrice: string | number`. Les photos ne sont pas encore incluses
 * par la recherche — l'interface utilise des cases colorées en attendant.
 */
export interface RoomSearchResult {
  id: string;
  propertyId: string;
  name: string;
  roomType: string;
  basePrice: string | number;
  maxGuests: number;
  bedCount: number;
  bedroomCount: number;
  unitCount?: number;
  /** Unités libres sur les dates cherchées (ou le total sans dates). */
  unitsLeft?: number;
  photos?: PropertyPhoto[];
  property: {
    id: string;
    title: string;
    propertyType: PropertyType;
    city: string;
    quarter: string;
    photos?: PropertyPhoto[];
    /** Hôte dont l'identité (KYC) est vérifiée. */
    identityVerified?: boolean;
    /** Logement vérifié sur place par SòôRooms. */
    isVerifiedByAgent?: boolean;
  };
}

export interface SearchRoomsResponse {
  results: RoomSearchResult[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function searchRooms(params: SearchRoomsParams = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : "";
  return request<SearchRoomsResponse>(`/search/rooms${suffix}`);
}

// ---------------------------------------------------------------------
// Requêtes authentifiées (Bearer) avec renouvellement automatique du token
// ---------------------------------------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Renouvelle la paire de tokens. La promesse est partagée entre appels
 * simultanés : le backend fait tourner les refresh tokens, donc deux
 * renouvellements parallèles avec le même token seraient pris pour un vol.
 */
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;
      try {
        const tokens = await request<AuthTokens>("/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken }),
        });
        saveTokens(tokens);
        return true;
      } catch (error) {
        // Une coupure réseau ne doit pas déconnecter l'utilisateur : on ne
        // vide la session que si le backend refuse réellement le refresh token.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          clearTokens();
          if (typeof window !== "undefined") window.location.assign("/login");
        }
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function authRequest<T>(path: string, options: RequestInit = {}, canRetry = true): Promise<T> {
  try {
    return await request<T>(path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${getAccessToken() ?? ""}` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && canRetry && (await refreshSession())) {
      return authRequest<T>(path, options, false);
    }
    throw error;
  }
}

// --- Compte hôte et KYC ------------------------------------------------

export type KycStatus = "NOT_SUBMITTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";

export interface KycDocumentSummary {
  id: string;
  status: KycStatus;
  reviewerNote: string | null;
  submittedAt: string;
}

export interface KycMine {
  kycStatus: KycStatus;
  documents: KycDocumentSummary[];
}

export function getMyKyc() {
  return authRequest<KycMine>("/kyc/mine");
}

/** Passe le compte en HOST (crée le profil hôte). Idempotent côté backend. */
export function becomeHost(payload: { bio?: string }) {
  return authRequest<unknown>("/auth/become-host", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitKyc(payload: { idCardUrl: string; proofOfAddressUrl?: string }) {
  return authRequest<unknown>("/kyc/submit", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --- Réservations ------------------------------------------------------

export type BookingStatus =
  | "NEGOTIATING"
  | "PENDING_PAYMENT"
  | "CONFIRMED_ESCROW"
  | "COMPLETED"
  | "DISPUTED"
  | "CANCELLED";

export interface MyBooking {
  id: string;
  checkInDate: string;
  checkOutDate: string;
  totalPrice: string | number | null;
  status: BookingStatus;
  createdAt: string;
  room: { id: string; name: string; propertyId: string };
}

export function getMyBookings() {
  return authRequest<MyBooking[]>("/bookings/mine");
}

// ---------------------------------------------------------------------
// Détail d'un logement (public) — GET /search/properties/:id
// ---------------------------------------------------------------------

export interface PropertyRoom {
  id: string;
  name: string;
  roomType: string;
  basePrice: string | number;
  maxGuests: number;
  bedCount: number;
  bedroomCount: number;
  /** Nombre d'unités identiques de ce type (ex. 20 chambres standard). */
  unitCount: number;
  /** Unités encore libres (aujourd'hui, ou sur les dates demandées) — fourni par la fiche publique. */
  unitsLeft?: number;
  photos?: PropertyPhoto[];
}

export interface PropertyDetail {
  id: string;
  title: string;
  description: string;
  propertyType: PropertyType;
  city: string;
  quarter: string;
  region: string | null;
  country: string | null;
  amenities: {
    hasWifi: boolean;
    hasGeneratorOrSolar: boolean;
    hasAc: boolean;
    hasParking: boolean;
    additionalEquipments: string[];
  } | null;
  rooms: PropertyRoom[];
  photos?: PropertyPhoto[];
  identityVerified?: boolean;
  isVerifiedByAgent?: boolean;
}

export function getProperty(id: string, dates?: { checkInDate: string; checkOutDate: string }) {
  const query = dates
    ? `?checkInDate=${encodeURIComponent(dates.checkInDate)}&checkOutDate=${encodeURIComponent(dates.checkOutDate)}`
    : "";
  return request<PropertyDetail>(`/search/properties/${encodeURIComponent(id)}${query}`);
}

// ---------------------------------------------------------------------
// Réservation : création, négociation, paiement, confirmation, litige
// ---------------------------------------------------------------------

export type OfferStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";

export interface PriceOffer {
  id: string;
  proposedByUserId: string;
  amount: string | number;
  status: OfferStatus;
  createdAt: string;
}

/** Réservation détaillée (réponse de POST /bookings et de GET /bookings/:id). */
export interface BookingDetail {
  id: string;
  travelerId: string;
  checkInDate: string;
  checkOutDate: string;
  totalPrice: string | number | null;
  status: BookingStatus;
  travelerConfirmedAt: string | null;
  hostConfirmedAt: string | null;
  disputeReason: string | null;
  /** Occupant, quand la réservation est faite pour quelqu'un d'autre. */
  guestName?: string | null;
  guestPhone?: string | null;
  currency?: string;
  createdAt: string;
  /** Du plus récent au plus ancien : offers[0] est l'offre en cours. */
  offers: PriceOffer[];
  room: {
    id: string;
    name: string;
    roomType: string;
    basePrice: string | number;
    property: { id: string; title: string; city: string; quarter: string };
  };
}

export interface CreateBookingPayload {
  roomId: string;
  checkInDate: string; // YYYY-MM-DD
  checkOutDate: string;
  /** Prix total proposé pour le séjour ; si absent, le backend applique le tarif affiché. */
  proposedPrice?: number;
  /** Réservation pour une autre personne : son nom (et un téléphone facultatif). */
  guestName?: string;
  guestPhone?: string;
}

export function createBooking(payload: CreateBookingPayload) {
  return authRequest<BookingDetail>("/bookings", { method: "POST", body: JSON.stringify(payload) });
}

/** Reçu voyageur — GET /bookings/:id/receipt (disponible une fois le paiement effectué). */
export interface BookingReceipt {
  reference: string;
  issuedAt: string;
  travelerName: string;
  guestName?: string | null;
  currency?: string;
  property: { title: string; city: string; quarter: string };
  roomName: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  stayPrice: number;
  travelerFee: number;
  travelerFeePercent: number | null;
  totalPaid: number;
  paymentMethod: string;
  refunded: boolean;
  /** Facture entreprise, null tant que le voyageur ne l'a pas demandée. */
  invoice: { number: string; company: string; address: string; taxId: string | null; issuedAt: string } | null;
}

/** Attestation de réservation signée par l'hôte (démarches de visa / court séjour). */
export interface BookingAttestation {
  code: string;
  bookingReference: string;
  signedAt: string;
  signerName: string;
  occupantName: string;
  payerName: string;
  property: { title: string; city: string; quarter: string };
  roomName: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  valid: boolean;
}

export interface AttestationVerification {
  valid: boolean;
  code: string;
  occupantName: string;
  property: { title: string; city: string; quarter: string };
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  signedAt: string;
  signerName: string;
}

/** Où en est l'attestation : sur demande uniquement, pour les voyageurs remplissant les conditions. */
export interface AttestationState {
  status: "NOT_ELIGIBLE" | "AVAILABLE" | "REQUESTED" | "DECLINED" | "SIGNED";
  reasons: string[];
  country: string | null;
  declineReason: string | null;
  attestation: BookingAttestation | null;
}

export const getAttestation = (id: string) => authRequest<AttestationState>(`/bookings/${encodeURIComponent(id)}/attestation`);
export const requestAttestation = (id: string, country: string) =>
  authRequest<{ alreadySigned: boolean }>(`/bookings/${encodeURIComponent(id)}/attestation/request`, {
    method: "POST",
    body: JSON.stringify({ country }),
  });
export const declineAttestation = (id: string, reason: string) =>
  authRequest<{ declined: boolean }>(`/bookings/${encodeURIComponent(id)}/attestation/decline`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
export const signAttestation = (id: string) =>
  authRequest<BookingAttestation>(`/bookings/${encodeURIComponent(id)}/attestation/sign`, { method: "POST" });
/** Public : aucune connexion requise. */
export const verifyAttestation = (code: string) =>
  request<AttestationVerification>(`/attestations/verify/${encodeURIComponent(code)}`);

export function getReceipt(id: string) {
  return authRequest<BookingReceipt>(`/bookings/${encodeURIComponent(id)}/receipt`);
}

export function issueInvoice(id: string, payload: { company: string; address: string; taxId?: string }) {
  return authRequest<BookingReceipt>(`/bookings/${encodeURIComponent(id)}/invoice`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getBooking(id: string) {
  return authRequest<BookingDetail>(`/bookings/${encodeURIComponent(id)}`);
}

const bookingAction = (id: string, action: string, body?: unknown) =>
  authRequest<BookingDetail>(`/bookings/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const counterOffer = (id: string, amount: number) => bookingAction(id, "offers", { amount });
export const acceptOffer = (id: string) => bookingAction(id, "accept");
export const rejectOffer = (id: string) => bookingAction(id, "reject");
export const confirmCheckin = (id: string) => bookingAction(id, "confirm-checkin");
export const raiseDispute = (id: string, reason: string) => bookingAction(id, "dispute", { reason });

export interface PaymentInitiation {
  escrowId: string;
  paymentUrl: string;
  gatewayRef: string;
}

export function initiatePayment(bookingId: string) {
  return authRequest<PaymentInitiation>(`/payments/bookings/${encodeURIComponent(bookingId)}/initiate`, {
    method: "POST",
  });
}

export interface PaymentVerification {
  confirmed: boolean;
  paymentStatus: "SUCCESS" | "FAILED" | "PENDING";
  bookingStatus: string;
}

/**
 * Au retour du voyageur : le serveur relit le paiement chez l'agrégateur et, s'il est réussi pour CETTE
 * réservation et au bon montant, la confirme. Complète le webhook, qui peut arriver en retard ou se perdre.
 */
export function verifyPaymentReturn(bookingId: string, reference: string) {
  return authRequest<PaymentVerification>(`/payments/bookings/${encodeURIComponent(bookingId)}/verify`, {
    method: "POST",
    body: JSON.stringify({ reference }),
  });
}

// ---------------------------------------------------------------------
// Côté hôte : logements, chambres, équipements, publication, réservations reçues
// ---------------------------------------------------------------------

export type PropertyStatus = "PENDING_KYC" | "ACTIVE" | "SUSPENDED";

export interface PropertyAmenities {
  hasWifi: boolean;
  hasGeneratorOrSolar: boolean;
  hasAc: boolean;
  hasParking: boolean;
  additionalEquipments: string[];
}

export type CollaboratorRole = "MANAGER" | "CO_MANAGER" | "AGENT" | "RECEPTIONIST" | "ACCOUNTANT";

export interface HostProperty {
  id: string;
  title: string;
  description: string;
  propertyType: PropertyType;
  city: string;
  quarter: string;
  region: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  status: PropertyStatus;
  isVerifiedByAgent?: boolean;
  /** Rôle de la personne connectée sur ce logement. */
  myRole?: CollaboratorRole | null;
  amenities: PropertyAmenities | null;
  rooms: PropertyRoom[];
  photos?: PropertyPhoto[];
}

export interface PropertyPayload {
  title: string;
  description: string;
  propertyType: PropertyType;
  city: string;
  quarter: string;
  region?: string;
  country?: string;
  latitude: number;
  longitude: number;
}

export interface RoomPayload {
  name: string;
  roomType: string;
  basePrice: number;
  maxGuests: number;
  bedCount?: number;
  bedroomCount?: number;
  unitCount?: number;
}

export function listMyProperties() {
  return authRequest<HostProperty[]>("/properties/mine");
}

export function getMyProperty(id: string) {
  return authRequest<HostProperty>(`/properties/${encodeURIComponent(id)}`);
}

export function createProperty(payload: PropertyPayload) {
  return authRequest<HostProperty>("/properties", { method: "POST", body: JSON.stringify(payload) });
}

export function updateProperty(id: string, payload: Partial<PropertyPayload>) {
  return authRequest<HostProperty>(`/properties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function updateAmenities(id: string, payload: Partial<PropertyAmenities>) {
  return authRequest<PropertyAmenities>(`/properties/${encodeURIComponent(id)}/amenities`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function publishProperty(id: string) {
  return authRequest<HostProperty>(`/properties/${encodeURIComponent(id)}/publish`, { method: "POST" });
}

export function createRoom(propertyId: string, payload: RoomPayload) {
  return authRequest<PropertyRoom>(`/properties/${encodeURIComponent(propertyId)}/rooms`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateRoom(propertyId: string, roomId: string, payload: Partial<RoomPayload>) {
  return authRequest<PropertyRoom>(
    `/properties/${encodeURIComponent(propertyId)}/rooms/${encodeURIComponent(roomId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export function deleteRoom(propertyId: string, roomId: string) {
  return authRequest<null>(`/properties/${encodeURIComponent(propertyId)}/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE",
  });
}

/** Réservation vue depuis un logement (GET /properties/:id/bookings). */
export interface PropertyBooking {
  id: string;
  roomId: string;
  travelerId: string;
  checkInDate: string;
  checkOutDate: string;
  totalPrice: string | number | null;
  status: BookingStatus;
  travelerConfirmedAt: string | null;
  hostConfirmedAt: string | null;
  createdAt: string;
  room: { id: string; name: string; propertyId: string };
  /** Une seule offre : la plus récente. */
  offers: PriceOffer[];
}

export function getPropertyBookings(propertyId: string) {
  return authRequest<PropertyBooking[]>(`/properties/${encodeURIComponent(propertyId)}/bookings`);
}

export const confirmHosting = (id: string) => bookingAction(id, "confirm-hosting");

// ---------------------------------------------------------------------
// Profil du compte connecté — GET /auth/me
// ---------------------------------------------------------------------

export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  /** Renseignée une fois l'adresse prouvée (lien reçu par e-mail, ou garantie par Google). */
  emailVerifiedAt: string | null;
  phone: string;
  role: "TRAVELER" | "HOST" | "ADMIN";
  kycStatus: KycStatus;
  avatarUrl: string | null;
  createdAt: string;
  hostProfile: { bio: string | null } | null;
}

export function getMe() {
  return authRequest<Me>("/auth/me");
}

// --- Photos (références par URL) ----------------------------------------

export interface PropertyPhoto {
  id: string;
  url: string;
  position: number;
}

export function addPropertyPhoto(propertyId: string, url: string) {
  return authRequest<PropertyPhoto>(`/properties/${encodeURIComponent(propertyId)}/photos`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function removePropertyPhoto(propertyId: string, photoId: string) {
  return authRequest<null>(
    `/properties/${encodeURIComponent(propertyId)}/photos/${encodeURIComponent(photoId)}`,
    { method: "DELETE" },
  );
}

export function addRoomPhoto(propertyId: string, roomId: string, url: string) {
  return authRequest<PropertyPhoto>(
    `/properties/${encodeURIComponent(propertyId)}/rooms/${encodeURIComponent(roomId)}/photos`,
    { method: "POST", body: JSON.stringify({ url }) },
  );
}

export function removeRoomPhoto(propertyId: string, roomId: string, photoId: string) {
  return authRequest<null>(
    `/properties/${encodeURIComponent(propertyId)}/rooms/${encodeURIComponent(roomId)}/photos/${encodeURIComponent(photoId)}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------
// Administration (rôle ADMIN) : KYC en attente, litiges
// ---------------------------------------------------------------------

export interface PendingKyc {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  profilePhotoUrl: string | null;
   document: { id: string; idCardUrl: string; proofOfAddressUrl: string | null; profilePhotoUrl: string | null; submittedAt: string } | null;
}

export interface AdminDispute {
  id: string;
  checkInDate: string;
  checkOutDate: string;
  totalPrice: string | number | null;
  disputeReason: string | null;
  travelerConfirmedAt: string | null;
  hostConfirmedAt: string | null;
  updatedAt: string;
  traveler: { id: string; fullName: string; phone: string };
  room: { name: string; property: { id: string; title: string; city: string } };
  escrowVault: { amountHeld: string | number; status: string } | null;
}

export const listPendingKyc = () => authRequest<PendingKyc[]>("/admin/kyc/pending");

export interface KycDocumentLink {
  url: string;
  /** Durée de validité du lien ; null pour un ancien document public. */
  expiresInSeconds: number | null;
}

/** Lien temporaire vers un document KYC privé, généré à la demande (il expire en quelques minutes). */
export const getKycDocumentLink = (documentId: string, kind: "id-card" | "proof-of-address") =>
  authRequest<KycDocumentLink>(`/admin/kyc/documents/${encodeURIComponent(documentId)}/${kind}`);
export const listDisputes = () => authRequest<AdminDispute[]>("/admin/disputes");

export const approveKyc = (userId: string) =>
  authRequest<unknown>(`/kyc/${encodeURIComponent(userId)}/approve`, { method: "POST" });

export const rejectKyc = (userId: string, reviewerNote: string) =>
  authRequest<unknown>(`/kyc/${encodeURIComponent(userId)}/reject`, {
    method: "POST",
    body: JSON.stringify({ reviewerNote }),
  });

// ---------------------------------------------------------------------
// Favoris (étoile) — /favorites
// ---------------------------------------------------------------------

export interface FavoriteProperty {
  id: string;
  title: string;
  propertyType: PropertyType;
  city: string;
  quarter: string;
  rooms: PropertyRoom[];
  photos: PropertyPhoto[];
}

export const getFavoriteIds = () => authRequest<string[]>("/favorites/ids");
export const getFavorites = () => authRequest<FavoriteProperty[]>("/favorites");

export const addFavorite = (propertyId: string) =>
  authRequest<{ propertyId: string }>(`/favorites/${encodeURIComponent(propertyId)}`, { method: "PUT" });

export const removeFavorite = (propertyId: string) =>
  authRequest<null>(`/favorites/${encodeURIComponent(propertyId)}`, { method: "DELETE" });

// ---------------------------------------------------------------------
// Téléversement de fichiers (Cloudinary, signature fournie par le backend)
// ---------------------------------------------------------------------

   export type UploadPurpose = "property_photo" | "kyc_document" | "avatar";

export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  allowedFormats: string;
  /** Présent pour les documents privés (« authenticated ») : à renvoyer tel quel à Cloudinary. */
  type?: string;
}

export function getUploadSignature(purpose: UploadPurpose) {
  return authRequest<UploadSignature>("/uploads/signature", {
    method: "POST",
    body: JSON.stringify({ purpose }),
  });
}

// ---------------------------------------------------------------------
// Mot de passe oublié — /auth/forgot-password, /auth/reset-password
// ---------------------------------------------------------------------

export interface ForgotPasswordResponse {
  message: string;
  /** Présent uniquement hors production : le jeton est renvoyé pour tester sans boîte e-mail. */
  devResetToken?: string;
}

export function forgotPassword(phone: string) {
  return request<ForgotPasswordResponse>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

export function resetPassword(token: string, newPassword: string) {
  return request<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });
}

// ---------------------------------------------------------------------
// Adresse e-mail — /auth/verify-email, /auth/resend-verification, /auth/email
// ---------------------------------------------------------------------

/** Public : le lien reçu par e-mail s'ouvre souvent sur un autre appareil que celui de l'inscription. */
export function verifyEmail(token: string) {
  return request<{ message: string }>("/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function resendVerification() {
  return authRequest<{ message: string }>("/auth/resend-verification", { method: "POST" });
}

/** Ajoute ou remplace l'adresse du compte ; le mot de passe actuel est exigé. */
export function setEmail(email: string, currentPassword: string) {
  return authRequest<{ message: string; emailSent: boolean }>("/auth/email", {
    method: "PUT",
    body: JSON.stringify({ email, currentPassword }),
  });
}