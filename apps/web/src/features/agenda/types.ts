export type AppointmentStatus =
  'SCHEDULED' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface AppointmentLine {
  serviceId: string;
  /** Lo resuelve la API; puede faltar en respuestas antiguas o dobles de pruebas. */
  name?: string | null;
  color?: string | null;
  durationMinutes?: number;
  price?: string;
}

export interface Appointment {
  id: string;
  clientId: string;
  /** Lo resuelve la API: la agenda no necesita el fichero de clientas para poner nombres. */
  clientName?: string | null;
  clientPhone?: string | null;
  stylistId: string;
  stylistName?: string | null;
  stylistColor?: string | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: AppointmentStatus | string;
  estimatedTotal: string;
  currency: string;
  services: AppointmentLine[];
  notes?: string | null;
  internalNotes?: string | null;
  cancellationReason?: string | null;
  reminderSentAt?: string | null;
  lastReminder?: {
    channel: string;
    status: 'SENT' | 'FAILED' | 'SKIPPED' | string;
    at: string;
    error: string | null;
  } | null;
  pendingChange?: {
    id: string;
    proposedStartsAt: string;
    reason: string | null;
    requestedAt: string;
  } | null;
}

export interface Stylist {
  id: string;
  displayName: string;
  color: string;
  isBookable: boolean;
}

/** Jornada y bloqueos de una profesional, para pintar el fondo de la parrilla. */
export interface StylistShifts {
  stylistId: string;
  name: string;
  color: string;
  isBookable: boolean;
  /** Servicios que hace. Vacío: todos. */
  serviceIds: string[];
  days: { date: string; intervals: { startsAt: string; endsAt: string }[] }[];
  blocks: { id: string; startsAt: string; endsAt: string; reason: string | null }[];
}

export interface Service {
  id: string;
  name: string;
  blockedMinutes: number;
  priceWithTax: string;
  currency: string;
  isBookable: boolean;
  color?: string | null;
  categoryId?: string | null;
}

export interface AgendaClient {
  id: string;
  fullName: string;
  phone: string | null;
  allergies?: string | null;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  stylistId: string;
}

export type ChangeRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface ChangeRequest {
  id: string;
  appointmentId: string;
  stylistId: string;
  stylistName: string | null;
  stylistColor: string | null;
  clientName: string | null;
  serviceNames: string[];
  durationMinutes: number;
  appointmentStatus: string | null;
  currentStartsAt: string;
  proposedStartsAt: string;
  reason: string | null;
  status: ChangeRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** Aviso del canal en vivo. Solo dice qué cambió; los datos se vuelven a pedir. */
export interface AgendaSignal {
  kind: 'appointment' | 'change-request' | 'block' | 'reminder' | 'ping';
  status?: string | null;
  /** Para quien solo ve su agenda: si el cambio es suyo. */
  mine?: boolean | null;
  stylistIds?: string[];
  at: string;
}
