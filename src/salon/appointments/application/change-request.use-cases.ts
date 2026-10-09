import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import {
  BusinessRuleViolationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/domain/ports/repository.port';
import { SALON_CONTEXT, type SalonContext } from '../../stylists/application/stylist.use-cases';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import { AGENDA_EVENTS, type AgendaEvents } from '../domain/agenda.ports';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
} from '../domain/appointment.repository';
import {
  AppointmentChangeRequest,
  type ChangeRequestStatusValue,
} from '../domain/change-request.entity';
import {
  CHANGE_REQUEST_REPOSITORY,
  type ChangeRequestRepository,
} from '../domain/change-request.repository';
import { RescheduleAppointmentUseCase } from './appointment.use-cases';

/**
 * Cambios de hora que piden las profesionales.
 *
 * El circuito es corto a propósito: la profesional pide, la encargada aprueba o rechaza, y
 * aprobar **mueve la cita** con el mismo caso de uso que usa recepción. No hay una segunda
 * forma de mover citas que pueda saltarse el horario o el solapamiento.
 */

export interface RequestChangeInput {
  readonly appointmentId: string;
  readonly proposedStartsAt: Date;
  readonly reason?: string | null;
  readonly actorId: string;
  /** Ficha de la profesional que pide. Solo puede pedir sobre sus citas. */
  readonly stylistId: string;
}

@Injectable()
export class RequestAppointmentChangeUseCase implements UseCase<
  RequestChangeInput,
  AppointmentChangeRequest
> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(CHANGE_REQUEST_REPOSITORY) private readonly requests: ChangeRequestRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SALON_CONTEXT) private readonly salon: SalonContext,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: RequestChangeInput): Promise<AppointmentChangeRequest> {
    const now = this.clock.now();
    const appointment = await this.appointments.findByIdOrFail(input.appointmentId);
    appointment.assertOwnedBy(input.stylistId);
    appointment.assertReschedulable();

    const request = AppointmentChangeRequest.open({
      id: this.ids.generate(),
      tenantId: appointment.tenantId,
      appointmentId: appointment.id,
      stylistId: appointment.stylistId,
      requestedBy: input.actorId,
      currentStartsAt: appointment.period.startsAt,
      proposedStartsAt: input.proposedStartsAt,
      reason: input.reason,
      now,
    });

    // Se comprueba ya que la hora propuesta cabe, aunque la decisión sea de la encargada:
    // una petición imposible solo le hace perder el tiempo a ella. Al aprobar se vuelve a
    // comprobar, porque entre una cosa y otra la agenda puede haber cambiado.
    const proposed = appointment.period.shiftTo(input.proposedStartsAt);
    const stylist = await this.stylists.findByIdOrFail(appointment.stylistId);
    if (!stylist.isWithinWorkingHours(proposed, this.salon.timeZone)) {
      throw new BusinessRuleViolationError(
        'OUTSIDE_WORKING_HOURS',
        'La hora propuesta queda fuera de tu jornada',
      );
    }
    const clashing = await this.appointments.findBlockingInRange(
      appointment.stylistId,
      proposed,
      appointment.id,
    );
    if (clashing.length > 0) {
      throw new ConflictError('APPOINTMENT_OVERLAP', 'Ya tienes otra cita a esa hora', {
        conflictsWith: clashing.map((other) => other.id),
      });
    }

    const pending = await this.requests.findPendingForAppointment(appointment.id);
    if (pending) {
      throw new ConflictError(
        'CHANGE_REQUEST_ALREADY_PENDING',
        'Ya pediste un cambio para esta cita. Retíralo antes de pedir otro.',
        { requestId: pending.id },
      );
    }

    const saved = await this.requests.create(request);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'AppointmentChangeRequest',
      entityId: saved.id,
      after: {
        appointmentId: saved.appointmentId,
        currentStartsAt: saved.currentStartsAt.toISOString(),
        proposedStartsAt: saved.proposedStartsAt.toISOString(),
        reason: saved.reason,
      },
    });
    this.events.publish({
      tenantId: saved.tenantId,
      kind: 'change-request',
      stylistIds: [saved.stylistId],
      status: saved.status,
      at: now,
    });

    return saved;
  }
}

export interface ListChangeRequestsInput {
  readonly status?: ChangeRequestStatusValue;
  readonly restrictToStylistId?: string | null;
  readonly decidedSince?: Date;
  readonly limit?: number;
}

@Injectable()
export class ListChangeRequestsUseCase implements UseCase<
  ListChangeRequestsInput,
  AppointmentChangeRequest[]
> {
  constructor(
    @Inject(CHANGE_REQUEST_REPOSITORY) private readonly requests: ChangeRequestRepository,
  ) {}

  execute(input: ListChangeRequestsInput): Promise<AppointmentChangeRequest[]> {
    return this.requests.list(
      {
        status: input.status,
        stylistId: input.restrictToStylistId ?? undefined,
        decidedSince: input.decidedSince,
      },
      Math.min(Math.max(input.limit ?? 50, 1), 100),
    );
  }
}

export interface DecideChangeInput {
  readonly id: string;
  readonly actorId: string;
  readonly note?: string | null;
}

/**
 * Aprueba el cambio y mueve la cita, en la misma transacción.
 *
 * Si la cita ya no cabe —otra clienta ocupó el hueco mientras la solicitud esperaba— la
 * aprobación falla con el error de siempre y la solicitud **sigue pendiente**: la
 * encargada puede proponer otra hora a la profesional o rechazarla con un motivo.
 */
@Injectable()
export class ApproveChangeRequestUseCase implements UseCase<
  DecideChangeInput,
  AppointmentChangeRequest
> {
  constructor(
    @Inject(CHANGE_REQUEST_REPOSITORY) private readonly requests: ChangeRequestRepository,
    private readonly reschedule: RescheduleAppointmentUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
  ) {}

  async execute(input: DecideChangeInput): Promise<AppointmentChangeRequest> {
    const request = await this.requests.findByIdOrFail(input.id);
    if (!request.isPending) {
      throw new InvalidStateTransitionError('La solicitud', request.status, 'APPROVED');
    }

    // Si recepción movió la cita mientras la petición esperaba, aprobarla pisaría ese cambio
    // con una hora pensada para otra situación.
    const appointment = await this.appointments.findByIdOrFail(request.appointmentId);
    if (appointment.period.startsAt.getTime() !== request.currentStartsAt.getTime()) {
      throw new ConflictError(
        'CHANGE_REQUEST_OUTDATED',
        'La cita se movió después de pedir el cambio. Recházalo y, si hace falta, que la ' +
          'profesional pida otra hora.',
      );
    }

    const now = this.clock.now();
    const saved = await this.unitOfWork.execute(async () => {
      await this.reschedule.execute({
        id: request.appointmentId,
        startsAt: request.proposedStartsAt,
        actorId: input.actorId,
      });
      request.approve(input.actorId, now, input.note);
      return this.requests.update(request);
    });

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'AppointmentChangeRequest',
      entityId: saved.id,
      before: { status: 'PENDING' },
      after: { status: saved.status, note: saved.decisionNote },
    });
    this.events.publish({
      tenantId: saved.tenantId,
      kind: 'change-request',
      stylistIds: [saved.stylistId],
      status: saved.status,
      at: now,
    });

    return saved;
  }
}

@Injectable()
export class RejectChangeRequestUseCase implements UseCase<
  DecideChangeInput,
  AppointmentChangeRequest
> {
  constructor(
    @Inject(CHANGE_REQUEST_REPOSITORY) private readonly requests: ChangeRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: DecideChangeInput): Promise<AppointmentChangeRequest> {
    const request = await this.requests.findByIdOrFail(input.id);
    const now = this.clock.now();
    request.reject(input.actorId, now, input.note);
    const saved = await this.requests.update(request);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'AppointmentChangeRequest',
      entityId: saved.id,
      before: { status: 'PENDING' },
      after: { status: saved.status, note: saved.decisionNote },
    });
    this.events.publish({
      tenantId: saved.tenantId,
      kind: 'change-request',
      stylistIds: [saved.stylistId],
      status: saved.status,
      at: now,
    });

    return saved;
  }
}

@Injectable()
export class WithdrawChangeRequestUseCase implements UseCase<
  { id: string; actorId: string; stylistId: string },
  AppointmentChangeRequest
> {
  constructor(
    @Inject(CHANGE_REQUEST_REPOSITORY) private readonly requests: ChangeRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: {
    id: string;
    actorId: string;
    stylistId: string;
  }): Promise<AppointmentChangeRequest> {
    const request = await this.requests.findByIdOrFail(input.id);
    const now = this.clock.now();
    request.withdraw(input.stylistId, input.actorId, now);
    const saved = await this.requests.update(request);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'AppointmentChangeRequest',
      entityId: saved.id,
      before: { status: 'PENDING' },
      after: { status: saved.status },
    });
    this.events.publish({
      tenantId: saved.tenantId,
      kind: 'change-request',
      stylistIds: [saved.stylistId],
      status: saved.status,
      at: now,
    });

    return saved;
  }
}
