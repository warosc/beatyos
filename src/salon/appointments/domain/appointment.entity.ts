import {
  BusinessRuleViolationError,
  DomainValidationError,
  ForbiddenActionError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { AggregateRoot, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { TimeRange } from '../../../shared/domain/value-objects/time-range.vo';

/**
 * Cita de la agenda.
 *
 * Es el agregado central del negocio: ocupa un sillón, compromete a una profesional y
 * acaba convirtiéndose en una factura. Concentra dos reglas que en cualquier otro sitio
 * se degradarían:
 *
 * 1. **Máquina de estados.** Una cita completada no puede cancelarse, y una cancelada no
 *    puede empezar. Sin la máquina, el estado se convierte en un campo que cualquiera
 *    escribe, y aparecen citas cobradas y canceladas a la vez.
 *
 * 2. **Precios congelados.** Cada línea guarda el precio y la duración **del momento en
 *    que se reservó**. Subir la tarifa del catálogo no puede cambiar lo que se le dijo a
 *    la clienta por teléfono la semana pasada.
 */

export type AppointmentStatusValue =
  'SCHEDULED' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export type AppointmentSourceValue = 'WALK_IN' | 'PHONE' | 'ONLINE' | 'STAFF';

/**
 * Línea de servicio de la cita.
 *
 * `price` y `durationMinutes` son copias, no referencias al catálogo. Es deliberado: un
 * documento histórico debe poder releerse igual dentro de cinco años.
 */
export interface AppointmentLine {
  readonly id: string;
  readonly serviceId: string;
  readonly durationMinutes: number;
  readonly price: Money;
  readonly sortOrder: number;
}

/**
 * Transiciones permitidas.
 *
 * Los estados finales —completada, cancelada, no presentada— no tienen salida. Es lo que
 * impide «descancelar» una cita: si la clienta vuelve a llamar, se reserva una nueva, y
 * el histórico conserva que hubo una cancelación. Reabrir la vieja borraría ese hecho.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<AppointmentStatusValue, readonly AppointmentStatusValue[]>
> = {
  SCHEDULED: ['CONFIRMED', 'IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  // Una cita en curso puede cancelarse: la clienta se marcha a mitad. No puede pasar a
  // «no presentada», porque evidentemente se presentó.
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** Estados que ocupan sillón. Coincide con la restricción EXCLUDE de la base de datos. */
export const BLOCKING_STATUSES: readonly AppointmentStatusValue[] = [
  'SCHEDULED',
  'CONFIRMED',
  'IN_PROGRESS',
];

export interface AppointmentProps {
  readonly tenantId: string;
  readonly clientId: string;
  readonly stylistId: string;
  readonly period: TimeRange;
  readonly status: AppointmentStatusValue;
  readonly source: AppointmentSourceValue;
  readonly notes: string | null;
  readonly internalNotes: string | null;
  readonly lines: readonly AppointmentLine[];
  readonly currency: string;
  readonly confirmedAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
  readonly cancellationReason: string | null;
  readonly noShowAt: Date | null;
  readonly reminderSentAt: Date | null;
  readonly audit: AuditMetadata;
}

export class Appointment extends AggregateRoot {
  private constructor(
    id: string,
    private props: AppointmentProps,
  ) {
    super(id);
  }

  static schedule(params: {
    id: string;
    tenantId: string;
    clientId: string;
    stylistId: string;
    startsAt: Date;
    lines: readonly AppointmentLine[];
    currency: string;
    source?: AppointmentSourceValue;
    notes?: string | null;
    internalNotes?: string | null;
    now: Date;
    actorId: string | null;
  }): Appointment {
    if (params.lines.length === 0) {
      throw new DomainValidationError('La cita debe incluir al menos un servicio', 'services');
    }

    const totalMinutes = params.lines.reduce((sum, line) => sum + line.durationMinutes, 0);
    const period = TimeRange.fromDuration(params.startsAt, totalMinutes);

    // Agendar en el pasado es casi siempre un error de tecleo en la fecha. Se permite un
    // margen de cinco minutos: la recepcionista que registra una visita que acaba de
    // empezar no debería pelearse con el reloj.
    if (period.startsAt.getTime() < params.now.getTime() - 5 * 60_000) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_IN_THE_PAST',
        'No se puede agendar una cita en el pasado',
        { startsAt: period.startsAt.toISOString(), now: params.now.toISOString() },
      );
    }

    return new Appointment(params.id, {
      tenantId: params.tenantId,
      clientId: params.clientId,
      stylistId: params.stylistId,
      period,
      status: 'SCHEDULED',
      source: params.source ?? 'WALK_IN',
      notes: params.notes ?? null,
      internalNotes: params.internalNotes ?? null,
      lines: [...params.lines],
      currency: params.currency,
      confirmedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      noShowAt: null,
      reminderSentAt: null,
      audit: {
        createdAt: params.now,
        updatedAt: params.now,
        deletedAt: null,
        createdBy: params.actorId,
        updatedBy: params.actorId,
        deletedBy: null,
      },
    });
  }

  static rehydrate(id: string, props: AppointmentProps): Appointment {
    return new Appointment(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get clientId(): string {
    return this.props.clientId;
  }
  get stylistId(): string {
    return this.props.stylistId;
  }
  get period(): TimeRange {
    return this.props.period;
  }
  get status(): AppointmentStatusValue {
    return this.props.status;
  }
  get source(): AppointmentSourceValue {
    return this.props.source;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get internalNotes(): string | null {
    return this.props.internalNotes;
  }
  get lines(): readonly AppointmentLine[] {
    return this.props.lines;
  }
  get currency(): string {
    return this.props.currency;
  }
  get confirmedAt(): Date | null {
    return this.props.confirmedAt;
  }
  get startedAt(): Date | null {
    return this.props.startedAt;
  }
  get completedAt(): Date | null {
    return this.props.completedAt;
  }
  get cancelledAt(): Date | null {
    return this.props.cancelledAt;
  }
  get cancelledBy(): string | null {
    return this.props.cancelledBy;
  }
  get cancellationReason(): string | null {
    return this.props.cancellationReason;
  }
  get noShowAt(): Date | null {
    return this.props.noShowAt;
  }
  get reminderSentAt(): Date | null {
    return this.props.reminderSentAt;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /**
   * Sella la baja lógica (ADR-0004).
   *
   * No borra: marca. El repositorio persiste el sello, pero la decisión pertenece al
   * dominio —es él quien sabe qué significa que algo esté dado de baja— y tenerla aquí
   * permite que los dobles en memoria de los tests reproduzcan el comportamiento real.
   */
  markDeleted(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: now,
        deletedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  /** Deshace la baja lógica. */
  markRestored(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  /** Importe previsto de la visita. El real vive en la factura. */
  get estimatedTotal(): Money {
    return Money.sum(
      this.props.lines.map((line) => line.price),
      this.props.currency,
    );
  }

  get durationMinutes(): number {
    return this.props.period.durationMinutes;
  }

  /** `true` si la cita ocupa sillón. Es lo que mira la comprobación de solapamiento. */
  get isBlocking(): boolean {
    return BLOCKING_STATUSES.includes(this.props.status) && !this.isDeleted;
  }

  get isFinished(): boolean {
    return ALLOWED_TRANSITIONS[this.props.status].length === 0;
  }

  // -- Máquina de estados ---------------------------------------------------

  confirm(now: Date, actorId: string | null): void {
    this.transitionTo('CONFIRMED', now, actorId);
    this.props = { ...this.props, confirmedAt: now };
  }

  start(now: Date, actorId: string | null): void {
    this.transitionTo('IN_PROGRESS', now, actorId);
    this.props = { ...this.props, startedAt: now };
  }

  complete(now: Date, actorId: string | null): void {
    this.transitionTo('COMPLETED', now, actorId);
    this.props = {
      ...this.props,
      completedAt: now,
      // Si nadie marcó el inicio, se asume la hora prevista. Ocurre a diario: en un salón
      // con trabajo nadie pulsa «empezar», y negarse a cerrar la cita por eso solo
      // conseguiría que la recepción dejase de usar el sistema.
      startedAt: this.props.startedAt ?? this.props.period.startsAt,
    };
  }

  cancel(reason: string, now: Date, actorId: string | null): void {
    this.transitionTo('CANCELLED', now, actorId);
    this.props = {
      ...this.props,
      cancelledAt: now,
      cancelledBy: actorId,
      cancellationReason: reason?.trim() || null,
    };
  }

  /**
   * Marca que la clienta no se presentó.
   *
   * Solo tiene sentido una vez pasada la hora: hacerlo antes es prejuzgar, y en la
   * práctica siempre es un error de manejo —alguien pulsó el botón equivocado.
   */
  markNoShow(now: Date, actorId: string | null): void {
    // El estado se comprueba ANTES que la hora. El orden importa para el mensaje: a una
    // cita ya en curso, decirle «aún no ha empezado» es absurdo y despista a quien lo lee.
    // Lo que ocurre es que no se puede marcar como ausente a quien está sentada delante.
    if (!ALLOWED_TRANSITIONS[this.props.status].includes('NO_SHOW')) {
      throw new InvalidStateTransitionError('La cita', this.props.status, 'NO_SHOW');
    }

    if (now.getTime() < this.props.period.startsAt.getTime()) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_NOT_DUE_YET',
        'No se puede marcar como no presentada una cita que aún no ha empezado',
        { startsAt: this.props.period.startsAt.toISOString() },
      );
    }

    this.transitionTo('NO_SHOW', now, actorId);
    this.props = { ...this.props, noShowAt: now };
  }

  private transitionTo(target: AppointmentStatusValue, now: Date, actorId: string | null): void {
    if (!ALLOWED_TRANSITIONS[this.props.status].includes(target)) {
      throw new InvalidStateTransitionError('La cita', this.props.status, target);
    }

    this.props = {
      ...this.props,
      status: target,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  // -- Cambios de agenda ----------------------------------------------------

  /**
   * Mueve la cita a otra hora, conservando la duración.
   *
   * Es lo que ocurre al arrastrarla en el calendario. Solo mientras esté pendiente: una
   * cita en curso no se mueve —ya está pasando— y una terminada, menos.
   */
  rescheduleTo(newStart: Date, now: Date, actorId: string | null): void {
    this.assertModifiable('reprogramar');

    if (newStart.getTime() < now.getTime() - 5 * 60_000) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_IN_THE_PAST',
        'No se puede mover una cita al pasado',
      );
    }

    this.props = {
      ...this.props,
      period: this.props.period.shiftTo(newStart),
      // Mover la cita invalida la confirmación: la clienta confirmó *aquella* hora, no
      // ésta. Volver a pedirla es lo correcto.
      status: this.props.status === 'CONFIRMED' ? 'SCHEDULED' : this.props.status,
      confirmedAt: null,
      reminderSentAt: null,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** Cambia de profesional sin mover la hora. */
  reassignTo(stylistId: string, now: Date, actorId: string | null): void {
    this.assertModifiable('reasignar');

    this.props = {
      ...this.props,
      stylistId,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Sustituye los servicios de la cita.
   *
   * La duración total cambia, así que el intervalo se recalcula conservando la hora de
   * inicio: quien añade un tratamiento espera que la cita termine más tarde, no que
   * empiece antes.
   */
  replaceLines(lines: readonly AppointmentLine[], now: Date, actorId: string | null): void {
    this.assertModifiable('modificar los servicios de');

    if (lines.length === 0) {
      throw new DomainValidationError('La cita debe incluir al menos un servicio', 'services');
    }

    const totalMinutes = lines.reduce((sum, line) => sum + line.durationMinutes, 0);

    this.props = {
      ...this.props,
      lines: [...lines],
      period: TimeRange.fromDuration(this.props.period.startsAt, totalMinutes),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  updateNotes(
    changes: { notes?: string | null; internalNotes?: string | null },
    now: Date,
    actorId: string | null,
  ): void {
    // Las notas sí se pueden editar en una cita terminada: es donde se apunta la fórmula
    // de color que se usó, y eso a veces se recuerda después.
    this.props = {
      ...this.props,
      notes: changes.notes !== undefined ? changes.notes : this.props.notes,
      internalNotes:
        changes.internalNotes !== undefined ? changes.internalNotes : this.props.internalNotes,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  markReminderSent(now: Date): void {
    this.props = { ...this.props, reminderSentAt: now };
  }

  // -- Reglas de acceso -----------------------------------------------------

  /**
   * Comprueba que el profesional indicado es el dueño de la cita.
   *
   * Sostiene el ámbito `.own` del ADR-0006. Vive en el dominio y no en el guard porque
   * «cuáles son mis citas» es una regla de negocio: el guard sabe qué acciones puede
   * hacer alguien, no sobre qué filas.
   */
  assertOwnedBy(stylistId: string): void {
    if (this.props.stylistId !== stylistId) {
      // El mensaje no revela de quién es la cita: sería información sobre la agenda de
      // una compañera.
      throw new ForbiddenActionError('acceder a esta cita', 'La cita pertenece a otro profesional');
    }
  }

  private assertModifiable(action: string): void {
    if (this.isFinished) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_ALREADY_FINISHED',
        `No se puede ${action} una cita ${this.statusLabel()}`,
        { status: this.props.status },
      );
    }
    if (this.props.status === 'IN_PROGRESS') {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_IN_PROGRESS',
        `No se puede ${action} una cita que ya ha empezado`,
      );
    }
  }

  private statusLabel(): string {
    return {
      SCHEDULED: 'pendiente',
      CONFIRMED: 'confirmada',
      IN_PROGRESS: 'en curso',
      COMPLETED: 'completada',
      CANCELLED: 'cancelada',
      NO_SHOW: 'marcada como no presentada',
    }[this.props.status];
  }
}
