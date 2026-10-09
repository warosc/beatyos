import { ConflictError, EntityNotFoundError } from '@shared/domain/errors';
import { TimeRange } from '@shared/domain/value-objects/time-range.vo';
import type {
  AgendaEvent,
  AgendaEvents,
  OutboundReminder,
  ReminderAttempt,
  ReminderChannelValue,
  ReminderContext,
  ReminderLog,
  ReminderSender,
} from '@salon/appointments/domain/agenda.ports';
import type { AppointmentChangeRequest } from '@salon/appointments/domain/change-request.entity';
import type {
  ChangeRequestFilter,
  ChangeRequestRepository,
} from '@salon/appointments/domain/change-request.repository';
import type { InMemoryAppointmentRepository } from './salon.doubles';

/** Bus de avisos que solo apunta lo publicado, para comprobar qué se avisó. */
export class RecordingAgendaEvents implements AgendaEvents {
  readonly published: AgendaEvent[] = [];
  publish(event: AgendaEvent): void {
    this.published.push(event);
  }
}

/**
 * Solicitudes de cambio en memoria. Respeta la misma regla que el índice único parcial de
 * PostgreSQL: como mucho una pendiente por cita.
 */
export class InMemoryChangeRequestRepository implements ChangeRequestRepository {
  private readonly items = new Map<string, AppointmentChangeRequest>();

  async findByIdOrFail(id: string): Promise<AppointmentChangeRequest> {
    const found = this.items.get(id);
    if (!found) throw new EntityNotFoundError('Solicitud de cambio', id);
    return found;
  }

  async findPendingForAppointment(appointmentId: string) {
    return (
      [...this.items.values()].find((r) => r.appointmentId === appointmentId && r.isPending) ?? null
    );
  }

  async list(filter: ChangeRequestFilter, limit: number) {
    return [...this.items.values()]
      .filter((r) => !filter.status || r.status === filter.status)
      .filter((r) => !filter.stylistId || r.stylistId === filter.stylistId)
      .slice(0, limit);
  }

  async countPending() {
    return [...this.items.values()].filter((r) => r.isPending).length;
  }

  async create(request: AppointmentChangeRequest) {
    if (await this.findPendingForAppointment(request.appointmentId)) {
      throw new ConflictError('CHANGE_REQUEST_ALREADY_PENDING', 'Ya hay un cambio pendiente');
    }
    this.items.set(request.id, request);
    return request;
  }

  async update(request: AppointmentChangeRequest) {
    this.items.set(request.id, request);
    return request;
  }
}

/** Canal de recordatorios falso: guarda lo enviado y puede simular que el proveedor falla. */
export class FakeReminderSender implements ReminderSender {
  readonly channel: ReminderChannelValue = 'WHATSAPP';
  readonly sent: OutboundReminder[] = [];
  failWith: string | null = null;

  async send(reminder: OutboundReminder) {
    if (this.failWith) throw new Error(this.failWith);
    this.sent.push(reminder);
    return { providerId: `msg-${this.sent.length}` };
  }
}

/**
 * Registro de recordatorios sobre el repositorio de citas en memoria. Los datos de cada
 * cita —nombre, teléfono— salen de un mapa que fija el test.
 */
export class InMemoryReminderLog implements ReminderLog {
  readonly attempts: ReminderAttempt[] = [];
  readonly tokens = new Map<string, string>();
  readonly contexts = new Map<string, Omit<ReminderContext, 'startsAt' | 'appointmentId'>>();

  constructor(private readonly appointments: InMemoryAppointmentRepository) {}

  async record(attempt: ReminderAttempt) {
    this.attempts.push(attempt);
  }

  async findDue(window: { from: Date; to: Date }, maxFailures: number) {
    const all = await this.appointments.findForCalendar(
      TimeRange.create(window.from, new Date(window.to.getTime() + 1)),
    );
    return all
      .filter((a) => a.status === 'SCHEDULED' || a.status === 'CONFIRMED')
      .filter((a) => a.reminderSentAt === null)
      .filter((a) => a.period.startsAt >= window.from && a.period.startsAt <= window.to)
      .filter(
        (a) =>
          !this.attempts.some((x) => x.appointmentId === a.id && x.status === 'SKIPPED') &&
          this.attempts.filter((x) => x.appointmentId === a.id && x.status === 'FAILED').length <
            maxFailures,
      )
      .map((a) => this.build(a.id, a.period.startsAt));
  }

  async contextFor(appointmentId: string) {
    const appointment = await this.appointments.findByIdOrFail(appointmentId);
    return this.build(appointmentId, appointment.period.startsAt);
  }

  async tenantsWithDue() {
    return [];
  }

  async markReminderSent(appointmentId: string, at: Date) {
    const appointment = await this.appointments.findByIdOrFail(appointmentId);
    appointment.markReminderSent(at);
  }

  async assignConfirmationToken(appointmentId: string, tokenHash: string) {
    this.tokens.set(tokenHash, appointmentId);
  }

  async findByConfirmationToken(tokenHash: string) {
    const appointmentId = this.tokens.get(tokenHash);
    return appointmentId ? { appointmentId, tenantId: 'tenant' } : null;
  }

  private build(appointmentId: string, startsAt: Date): ReminderContext {
    const context = this.contexts.get(appointmentId) ?? {
      tenantId: 'tenant',
      salonName: 'Salón Demo',
      clientFirstName: 'Rosa',
      clientPhone: '5555-1234',
      stylistName: 'Sara Molina',
      serviceNames: ['Corte'],
    };
    return { ...context, appointmentId, startsAt };
  }
}
