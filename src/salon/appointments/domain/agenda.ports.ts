/**
 * Puertos de la agenda que no son el repositorio de citas.
 *
 * Cada uno resuelve una necesidad de la pantalla o del salón que la cita, por sí sola, no
 * cubre: poner nombre y color a lo que se pinta, avisar a quien tiene la agenda abierta
 * de que algo ha cambiado, y recordar la cita a la clienta.
 */

// ---------------------------------------------------------------------------
// Etiquetas para pintar la agenda
// ---------------------------------------------------------------------------

export interface ClientLabel {
  readonly name: string;
  readonly phone: string | null;
}

export interface StylistLabel {
  readonly name: string;
  readonly color: string;
}

export interface ServiceLabel {
  readonly name: string;
  readonly color: string | null;
}

export interface PendingChangeLabel {
  readonly id: string;
  readonly proposedStartsAt: Date;
  readonly reason: string | null;
  readonly requestedAt: Date;
}

export interface ReminderLabel {
  readonly channel: string;
  readonly status: string;
  readonly at: Date;
  readonly error: string | null;
}

export interface AgendaLabels {
  readonly clients: ReadonlyMap<string, ClientLabel>;
  readonly stylists: ReadonlyMap<string, StylistLabel>;
  readonly services: ReadonlyMap<string, ServiceLabel>;
  /** Por cita: la solicitud de cambio pendiente, si la hay. */
  readonly pendingChanges: ReadonlyMap<string, PendingChangeLabel>;
  /** Por cita: el último intento de recordatorio. */
  readonly lastReminders: ReadonlyMap<string, ReminderLabel>;
}

/**
 * Nombres, teléfonos y colores para pintar citas.
 *
 * La cita guarda identificadores; el resto es presentación. Se resuelve en el servidor y
 * en una consulta por tipo, para que la agenda —y «Mi día», que se abre en un móvil— no
 * tenga que descargar el fichero de clientas, el equipo y el catálogo enteros solo para
 * poner un nombre a cada bloque.
 */
export interface AgendaDirectory {
  describe(
    appointments: readonly {
      readonly id: string;
      readonly clientId: string;
      readonly stylistId: string;
      readonly serviceIds: readonly string[];
    }[],
  ): Promise<AgendaLabels>;
  /** Resumen de citas por id, para listar solicitudes de cambio sin pedir cada cita. */
  summarize(appointmentIds: readonly string[]): Promise<ReadonlyMap<string, AppointmentSummary>>;
}

export interface AppointmentSummary {
  readonly clientName: string;
  readonly stylistName: string;
  readonly stylistColor: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  readonly serviceNames: readonly string[];
}

export const AGENDA_DIRECTORY = Symbol('AgendaDirectory');

// ---------------------------------------------------------------------------
// Avisos en tiempo real
// ---------------------------------------------------------------------------

export type AgendaEventKind = 'appointment' | 'change-request' | 'block' | 'reminder';

/**
 * Algo cambió en la agenda de un salón.
 *
 * El aviso no lleva datos de la clienta, solo qué cambió y a qué profesionales afecta:
 * quien lo recibe vuelve a pedir la agenda por la vía normal, que es la que aplica los
 * permisos. Así un aviso nunca puede filtrar lo que la petición no dejaría ver.
 */
export interface AgendaEvent {
  readonly tenantId: string;
  readonly kind: AgendaEventKind;
  readonly stylistIds: readonly string[];
  /** Para `change-request`: en qué quedó. Lo usa el aviso a la profesional o a la encargada. */
  readonly status?: string;
  readonly at: Date;
}

export interface AgendaEvents {
  publish(event: AgendaEvent): void;
}

export const AGENDA_EVENTS = Symbol('AgendaEvents');

// ---------------------------------------------------------------------------
// Recordatorios a la clienta
// ---------------------------------------------------------------------------

export type ReminderChannelValue = 'WHATSAPP' | 'SMS' | 'LOG' | 'MANUAL';
export type ReminderDeliveryValue = 'SENT' | 'FAILED' | 'SKIPPED';

export interface OutboundReminder {
  /** Teléfono en formato internacional, `+50255551234`. */
  readonly to: string;
  readonly body: string;
}

/**
 * Canal por el que sale el recordatorio.
 *
 * `send` lanza si el proveedor rechaza el mensaje; el caso de uso lo anota como fallido y
 * lo reintenta en la siguiente pasada. Como el correo, promete aceptación, no entrega.
 */
export interface ReminderSender {
  readonly channel: ReminderChannelValue;
  send(reminder: OutboundReminder): Promise<{ providerId: string | null }>;
}

export const REMINDER_SENDER = Symbol('ReminderSender');

export interface ReminderAttempt {
  readonly id: string;
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly channel: ReminderChannelValue;
  readonly recipient: string | null;
  readonly status: ReminderDeliveryValue;
  readonly error: string | null;
  readonly providerId: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

/** Datos para redactar el recordatorio de una cita. */
export interface ReminderContext {
  readonly appointmentId: string;
  readonly tenantId: string;
  readonly salonName: string;
  readonly clientFirstName: string;
  readonly clientPhone: string | null;
  readonly stylistName: string;
  readonly serviceNames: readonly string[];
  readonly startsAt: Date;
}

export interface ReminderLog {
  record(attempt: ReminderAttempt): Promise<void>;
  /**
   * Citas del salón activo a las que toca recordar: pendientes o confirmadas, que empiezan
   * dentro de la ventana, sin recordatorio enviado, sin descarte previo y con menos de
   * `maxFailures` intentos fallidos.
   */
  findDue(window: { from: Date; to: Date }, maxFailures: number): Promise<ReminderContext[]>;
  contextFor(appointmentId: string): Promise<ReminderContext>;
  /** Salones con citas a recordar en la ventana. Lo usa el planificador, entre salones. */
  tenantsWithDue(window: { from: Date; to: Date }): Promise<string[]>;
  markReminderSent(appointmentId: string, at: Date): Promise<void>;
  /** Guarda el hash del enlace de confirmación. Uno nuevo invalida el anterior. */
  assignConfirmationToken(appointmentId: string, tokenHash: string): Promise<void>;
  /**
   * Localiza la cita de un enlace de confirmación **entre salones**: quien abre el enlace
   * no ha iniciado sesión, y el salón se averigua precisamente por el enlace.
   */
  findByConfirmationToken(
    tokenHash: string,
  ): Promise<{ appointmentId: string; tenantId: string } | null>;
}

export const REMINDER_LOG = Symbol('ReminderLog');

/** Ajustes de los recordatorios. Salen de la configuración del despliegue. */
export interface ReminderSettings {
  readonly enabled: boolean;
  /** Cuántas horas antes de la cita se avisa. */
  readonly leadHours: number;
  /** Por debajo de esta antelación ya no se avisa: la clienta acaba de reservar. */
  readonly minimumLeadMinutes: number;
  /** Dirección pública de la interfaz, para el enlace de confirmación. */
  readonly publicWebUrl: string;
  /** Prefijo internacional para teléfonos guardados sin él, p. ej. `502`. */
  readonly defaultCountryCode: string;
  readonly timeZone: string;
}

export const REMINDER_SETTINGS = Symbol('ReminderSettings');
