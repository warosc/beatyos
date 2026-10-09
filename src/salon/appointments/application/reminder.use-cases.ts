import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import { BusinessRuleViolationError } from '../../../shared/domain/errors';
import {
  AGENDA_EVENTS,
  REMINDER_LOG,
  REMINDER_SENDER,
  REMINDER_SETTINGS,
  type AgendaEvents,
  type ReminderContext,
  type ReminderLog,
  type ReminderSender,
  type ReminderSettings,
} from '../domain/agenda.ports';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
} from '../domain/appointment.repository';
import type { AppointmentStatusValue } from '../domain/appointment.entity';
import {
  composeReminderMessage,
  toInternationalPhone,
  whatsappLink,
} from '../domain/reminder-message';

/**
 * Recordatorios de cita a la clienta.
 *
 * Una clienta que no se presenta es una hora de sillón perdida que ya no se puede vender.
 * El recordatorio con enlace para confirmar o cancelar es la medida que más reduce esas
 * ausencias, y el enlace convierte una cancelación de última hora en un hueco que recepción
 * todavía puede ocupar.
 */

/** Tras tres fallos seguidos se deja de insistir: el problema no se va a arreglar solo. */
const MAX_FAILURES = 3;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** Enlace corto, sin significado y de un solo salón: 144 bits de azar. */
const newToken = () => randomBytes(18).toString('base64url');

export interface ReminderRunSummary {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Envía los recordatorios pendientes del salón activo.
 *
 * Lo invoca el planificador para cada salón con citas en la ventana, y recepción puede
 * lanzarlo a mano. Es idempotente: una cita recordada no vuelve a recordarse hasta que
 * cambie de hora, que es cuando la reprogramación borra la marca.
 */
@Injectable()
export class SendDueRemindersUseCase implements UseCase<
  { actorId?: string | null },
  ReminderRunSummary
> {
  private readonly logger = new Logger(SendDueRemindersUseCase.name);

  constructor(
    @Inject(REMINDER_LOG) private readonly log: ReminderLog,
    @Inject(REMINDER_SENDER) private readonly sender: ReminderSender,
    @Inject(REMINDER_SETTINGS) private readonly settings: ReminderSettings,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: { actorId?: string | null } = {}): Promise<ReminderRunSummary> {
    // Sin proveedor no se «envía» nada: anotar la cita como recordada dejaría a recepción
    // creyendo que la clienta fue avisada, y esa cita ya no se recordaría de verdad nunca.
    if (this.sender.channel === 'LOG') {
      throw new BusinessRuleViolationError(
        'REMINDER_PROVIDER_NOT_CONFIGURED',
        'Los recordatorios automáticos necesitan un proveedor de WhatsApp o SMS. Mientras ' +
          'tanto, abre la cita y usa «Recordar por WhatsApp».',
      );
    }
    const now = this.clock.now();
    const due = await this.log.findDue(reminderWindow(now, this.settings), MAX_FAILURES);
    const summary = { sent: 0, failed: 0, skipped: 0 };

    for (const context of due) {
      const outcome = await this.sendOne(context, now, input.actorId ?? null);
      summary[outcome] += 1;
    }

    if (due.length > 0) {
      this.logger.log(
        `Recordatorios: ${summary.sent} enviados, ${summary.failed} fallidos, ` +
          `${summary.skipped} sin teléfono`,
      );
      this.events.publish({
        tenantId: due[0].tenantId,
        kind: 'reminder',
        stylistIds: [],
        at: now,
      });
    }

    return summary;
  }

  private async sendOne(
    context: ReminderContext,
    now: Date,
    actorId: string | null,
  ): Promise<keyof ReminderRunSummary> {
    const phone = toInternationalPhone(context.clientPhone, this.settings.defaultCountryCode);
    const base = {
      id: this.ids.generate(),
      tenantId: context.tenantId,
      appointmentId: context.appointmentId,
      channel: this.sender.channel,
      recipient: phone,
      providerId: null,
      createdAt: now,
      createdBy: actorId,
    };

    if (!phone) {
      // Se anota como descartado y no se reintenta: sin teléfono no hay a quién avisar, y
      // recepción lo ve en la ficha de la cita para llamarla si hace falta.
      await this.log.record({
        ...base,
        status: 'SKIPPED',
        error: 'La clienta no tiene un teléfono válido',
      });
      return 'skipped';
    }

    const token = newToken();
    await this.log.assignConfirmationToken(context.appointmentId, digest(token));
    const body = composeReminderMessage(
      context,
      confirmationUrl(this.settings, token),
      this.settings.timeZone,
    );

    try {
      const { providerId } = await this.sender.send({ to: phone, body });
      await this.log.record({ ...base, status: 'SENT', error: null, providerId });
      await this.log.markReminderSent(context.appointmentId, now);
      return 'sent';
    } catch (error) {
      await this.log.record({
        ...base,
        status: 'FAILED',
        error: error instanceof Error ? error.message.slice(0, 500) : 'Error desconocido',
      });
      return 'failed';
    }
  }
}

export interface ManualReminder {
  readonly message: string;
  readonly phone: string | null;
  readonly whatsappUrl: string | null;
}

/**
 * Recordatorio que envía recepción desde su propio WhatsApp.
 *
 * Funciona sin proveedor contratado: devuelve el mensaje ya redactado y un enlace `wa.me`
 * que abre la conversación con la clienta. Se anota como enviado al prepararlo, porque es
 * lo que pasa en la práctica y porque así el envío automático no lo repite.
 */
@Injectable()
export class PrepareManualReminderUseCase implements UseCase<
  { appointmentId: string; actorId: string },
  ManualReminder
> {
  constructor(
    @Inject(REMINDER_LOG) private readonly log: ReminderLog,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(REMINDER_SETTINGS) private readonly settings: ReminderSettings,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: { appointmentId: string; actorId: string }): Promise<ManualReminder> {
    const appointment = await this.appointments.findByIdOrFail(input.appointmentId);
    if (!appointment.isBlocking || appointment.status === 'IN_PROGRESS') {
      throw new BusinessRuleViolationError(
        'REMINDER_NOT_APPLICABLE',
        'Solo se recuerdan citas pendientes o confirmadas',
      );
    }

    const now = this.clock.now();
    const context = await this.log.contextFor(appointment.id);
    const phone = toInternationalPhone(context.clientPhone, this.settings.defaultCountryCode);
    const token = newToken();
    await this.log.assignConfirmationToken(appointment.id, digest(token));
    const message = composeReminderMessage(
      context,
      confirmationUrl(this.settings, token),
      this.settings.timeZone,
    );

    await this.log.record({
      id: this.ids.generate(),
      tenantId: context.tenantId,
      appointmentId: appointment.id,
      channel: 'MANUAL',
      recipient: phone,
      status: 'SENT',
      error: null,
      providerId: null,
      createdAt: now,
      createdBy: input.actorId,
    });
    await this.log.markReminderSent(appointment.id, now);
    this.events.publish({
      tenantId: context.tenantId,
      kind: 'reminder',
      stylistIds: [appointment.stylistId],
      at: now,
    });

    return { message, phone, whatsappUrl: phone ? whatsappLink(phone, message) : null };
  }
}

// ---------------------------------------------------------------------------
// Enlace de la clienta
// ---------------------------------------------------------------------------

export interface PublicAppointmentView {
  readonly salonName: string;
  readonly clientFirstName: string;
  readonly stylistName: string;
  readonly serviceNames: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: AppointmentStatusValue;
  readonly canConfirm: boolean;
  readonly canCancel: boolean;
}

/**
 * Lo que ve la clienta al abrir el enlace, y lo que puede hacer con él.
 *
 * El salón activo lo fija quien llama, a partir del propio enlace: este caso de uso ya
 * corre dentro de él y no sabe nada de tokens. Muestra lo mínimo para reconocer su cita
 * —nombre de pila, hora, profesional y servicios—, nunca el teléfono ni notas internas.
 */
@Injectable()
export class PublicAppointmentLinkUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(REMINDER_LOG) private readonly log: ReminderLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async view(appointmentId: string): Promise<PublicAppointmentView> {
    const appointment = await this.appointments.findByIdOrFail(appointmentId);
    const context = await this.log.contextFor(appointmentId);
    const upcoming = appointment.period.startsAt.getTime() > this.clock.now().getTime();

    return {
      salonName: context.salonName,
      clientFirstName: context.clientFirstName,
      stylistName: context.stylistName,
      serviceNames: context.serviceNames,
      startsAt: appointment.period.startsAt.toISOString(),
      endsAt: appointment.period.endsAt.toISOString(),
      status: appointment.status,
      canConfirm: upcoming && appointment.status === 'SCHEDULED',
      canCancel:
        upcoming && (appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED'),
    };
  }

  async confirm(appointmentId: string): Promise<PublicAppointmentView> {
    const appointment = await this.appointments.findByIdOrFail(appointmentId);
    this.assertUpcoming(appointment.period.startsAt);
    // Confirmar dos veces no es un error para quien pulsa el enlace dos veces.
    if (appointment.status !== 'CONFIRMED') {
      appointment.confirm(this.clock.now(), null);
      await this.appointments.update(appointment);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Appointment',
        entityId: appointment.id,
        before: { status: 'SCHEDULED' },
        after: { status: 'CONFIRMED', via: 'enlace de la clienta' },
      });
    }
    return this.view(appointmentId);
  }

  async cancel(appointmentId: string, reason?: string | null): Promise<PublicAppointmentView> {
    const appointment = await this.appointments.findByIdOrFail(appointmentId);
    this.assertUpcoming(appointment.period.startsAt);
    if (appointment.status !== 'CANCELLED') {
      const previous = appointment.status;
      appointment.cancel(
        `Cancelada por la clienta desde el recordatorio${reason?.trim() ? `: ${reason.trim()}` : ''}`,
        this.clock.now(),
        null,
      );
      await this.appointments.update(appointment);
      await this.audit.record({
        action: 'UPDATE',
        entityType: 'Appointment',
        entityId: appointment.id,
        before: { status: previous },
        after: { status: 'CANCELLED', via: 'enlace de la clienta' },
      });
    }
    return this.view(appointmentId);
  }

  // El aviso a quien tiene la agenda abierta lo da el repositorio al guardar la cita.
  private assertUpcoming(startsAt: Date): void {
    if (startsAt.getTime() <= this.clock.now().getTime()) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_LINK_EXPIRED',
        'Esta cita ya pasó. Si necesitas algo, llama al salón.',
      );
    }
  }
}

/** Hash del token de un enlace. Lo usa el adaptador HTTP para localizar la cita. */
export const confirmationTokenDigest = digest;

/** Citas a recordar: las que empiezan entre la antelación mínima y la de aviso. */
export function reminderWindow(now: Date, settings: ReminderSettings) {
  return {
    from: new Date(now.getTime() + settings.minimumLeadMinutes * 60_000),
    to: new Date(now.getTime() + settings.leadHours * 3_600_000),
  };
}

function confirmationUrl(settings: ReminderSettings, token: string): string {
  return `${settings.publicWebUrl.replace(/\/$/, '')}/cita/${token}`;
}
