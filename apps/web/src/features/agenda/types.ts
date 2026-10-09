export interface Appointment {
  id: string;
  clientId: string;
  /** Lo resuelve la API: la agenda no necesita el fichero de clientas para poner nombres. */
  clientName?: string | null;
  stylistId: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: string;
  estimatedTotal: string;
  currency: string;
  services: { serviceId: string }[];
}
/** Cómo se llama cada estado de una cita en el salón. */
export const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Agendada',
  CONFIRMED: 'Confirmada',
  IN_PROGRESS: 'En atención',
  COMPLETED: 'Realizada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No vino',
};

/** Estados en los que la cita ya terminó: no admite más cambios. */
export const FINAL_APPOINTMENT_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'NO_SHOW']);

export interface Stylist {
  id: string;
  displayName: string;
  color: string;
  isBookable: boolean;
  /** Servicios que hace. Sin ninguno registrado, hace de todo (así lo entiende la API). */
  skills?: { serviceId: string }[];
}
export interface Service {
  id: string;
  name: string;
  blockedMinutes: number;
  priceWithTax: string;
  currency: string;
  isBookable: boolean;
  categoryId?: string | null;
}
