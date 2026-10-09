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
  EntityNotFoundError,
  ForbiddenActionError,
} from '../../../shared/domain/errors';
import {
  UNIT_OF_WORK,
  type Page,
  type PageRequest,
  type UnitOfWork,
} from '../../../shared/domain/ports/repository.port';
import {
  addCalendarDays,
  formatCalendarDay,
  type CalendarDay,
  instantToCalendarDay,
  parseCalendarDay,
  timeZoneOffsetMs,
} from '../../../shared/domain/time/zoned-time';
import { TimeRange } from '../../../shared/domain/value-objects/time-range.vo';
import {
  SERVICE_REPOSITORY,
  type ServiceRepository,
} from '../../catalog/domain/catalog.repositories';
import { SALON_CONTEXT, type SalonContext } from '../../stylists/application/stylist.use-cases';
import type { Stylist } from '../../stylists/domain/stylist.entity';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import {
  Appointment,
  type AppointmentLine,
  type AppointmentSourceValue,
} from '../domain/appointment.entity';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentFilter,
  type AppointmentRepository,
  type AppointmentSortField,
} from '../domain/appointment.repository';
import { AGENDA_EVENTS, type AgendaEvents } from '../domain/agenda.ports';
import { AvailabilityService } from '../domain/availability.service';

/**
 * Casos de uso de la agenda.
 *
 * Aquí se orquesta lo que ningún agregado puede hacer solo: reservar exige el horario del
 * profesional, el catálogo de servicios y las citas existentes. Es exactamente el trabajo
 * de la capa de aplicación —coordinar, no decidir—: cada regla concreta sigue viviendo en
 * el dominio que le corresponde.
 */

export interface ScheduleAppointmentInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly stylistId: string;
  readonly startsAt: Date;
  readonly serviceIds: readonly string[];
  readonly source?: AppointmentSourceValue;
  readonly notes?: string | null;
  readonly internalNotes?: string | null;
  readonly actorId: string | null;
  /** Permite reservar fuera del horario. Requiere permiso; se audita. */
  readonly force?: boolean;
  /** Ámbito `appointments.create.own`: la cita solo puede ser de este profesional. */
  readonly restrictToStylistId?: string | null;
}

@Injectable()
export class ScheduleAppointmentUseCase implements UseCase<ScheduleAppointmentInput, Appointment> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(SALON_CONTEXT) private readonly salon: SalonContext,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: ScheduleAppointmentInput): Promise<Appointment> {
    const now = this.clock.now();

    // El ámbito propio se comprueba antes que nada: quien solo tiene
    // `appointments.create.own` no puede ampliar su alcance mandando el `stylistId` de otra
    // persona en el cuerpo de la petición.
    if (input.restrictToStylistId && input.stylistId !== input.restrictToStylistId) {
      throw new ForbiddenActionError(
        'agendar para otro profesional',
        'Solo puede reservar citas para sí misma',
      );
    }

    if (input.serviceIds.length === 0) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_WITHOUT_SERVICES',
        'Indique al menos un servicio para la cita',
      );
    }

    const stylist = await this.stylists.findByIdOrFail(input.stylistId);
    if (!stylist.isBookable()) {
      throw new BusinessRuleViolationError(
        'STYLIST_NOT_BOOKABLE',
        `${stylist.displayName} no admite reservas en este momento`,
        { status: stylist.status },
      );
    }

    // Una sola consulta para todos los servicios, no una por cada uno: es el camino más
    // caliente del sistema y el N+1 aquí se nota.
    const services = await this.services.findManyByIds(input.serviceIds);
    const byId = new Map(services.map((service) => [service.id, service]));

    const lines: AppointmentLine[] = input.serviceIds.map((serviceId, index) => {
      const service = byId.get(serviceId);
      if (!service) {
        throw new EntityNotFoundError('Servicio', serviceId);
      }
      if (!service.isBookable()) {
        throw new BusinessRuleViolationError(
          'SERVICE_NOT_BOOKABLE',
          `El servicio "${service.name}" está retirado del catálogo`,
          { serviceId },
        );
      }
      if (!stylist.canPerform(serviceId)) {
        throw new BusinessRuleViolationError(
          'STYLIST_CANNOT_PERFORM_SERVICE',
          `${stylist.displayName} no realiza el servicio "${service.name}"`,
          { serviceId, stylistId: stylist.id },
        );
      }

      return {
        id: this.ids.generate(),
        serviceId,
        // Duración efectiva de ESTE profesional, no la del catálogo: una veterana que
        // tarda 30 en lo que el catálogo reserva 45 libera un hueco vendible cada vez.
        // Se suma el margen de limpieza, que bloquea agenda aunque no se facture.
        durationMinutes:
          stylist.durationFor(serviceId, service.durationMinutes) + service.bufferMinutes,
        // El precio se **congela** aquí: subir la tarifa mañana no puede cambiar lo que se
        // le dijo hoy a la clienta por teléfono.
        price: service.price,
        sortOrder: index,
      };
    });

    const appointment = Appointment.schedule({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      clientId: input.clientId,
      stylistId: input.stylistId,
      startsAt: input.startsAt,
      lines,
      currency: services[0]?.price.currency ?? 'GTQ',
      source: input.source,
      notes: input.notes ?? null,
      internalNotes: input.internalNotes ?? null,
      now,
      actorId: input.actorId,
    });

    if (!input.force) {
      await this.assertFitsInAgenda(stylist, appointment.period);
    }

    // La transacción abarca la comprobación y la escritura. Aun así, la garantía real
    // contra el solapamiento la da la restricción EXCLUDE de PostgreSQL: entre la
    // comprobación y el INSERT cabe otra petición, y ninguna consulta previa puede
    // cerrar esa ventana (ADR-0011).
    const saved = await this.unitOfWork.execute(() => this.appointments.create(appointment));

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Appointment',
      entityId: saved.id,
      after: {
        clientId: saved.clientId,
        stylistId: saved.stylistId,
        startsAt: saved.period.startsAt.toISOString(),
        durationMinutes: saved.durationMinutes,
        estimatedTotal: saved.estimatedTotal.toDecimalString(),
        ...(input.force ? { forcedOutsideSchedule: true } : {}),
      },
    });

    return saved;
  }

  /**
   * Comprueba que la cita cabe: dentro del horario y sin pisar otra.
   *
   * Es una comprobación **de cortesía**, no la garantía. Sirve para dar un mensaje que la
   * recepcionista entienda —«Sara ya tiene una cita a esa hora»— en lugar de un error de
   * restricción de PostgreSQL. La garantía la da la base de datos.
   */
  private async assertFitsInAgenda(
    stylist: Awaited<ReturnType<StylistRepository['findByIdOrFail']>>,
    period: TimeRange,
  ): Promise<void> {
    if (!stylist.isWithinWorkingHours(period, this.salon.timeZone)) {
      throw new BusinessRuleViolationError(
        'OUTSIDE_WORKING_HOURS',
        `El horario solicitado queda fuera de la jornada de ${stylist.displayName}`,
        {
          startsAt: period.startsAt.toISOString(),
          endsAt: period.endsAt.toISOString(),
        },
      );
    }

    const blocking = await this.appointments.findBlockingInRange(stylist.id, period);
    if (blocking.length > 0) {
      throw new ConflictError(
        'APPOINTMENT_OVERLAP',
        `${stylist.displayName} ya tiene otra cita en esa franja horaria`,
        { conflictsWith: blocking.map((appointment) => appointment.id) },
      );
    }
  }
}

export interface RescheduleInput {
  readonly id: string;
  readonly startsAt?: Date;
  readonly stylistId?: string;
  readonly actorId: string | null;
  readonly force?: boolean;
}

@Injectable()
export class RescheduleAppointmentUseCase implements UseCase<RescheduleInput, Appointment> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SALON_CONTEXT) private readonly salon: SalonContext,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: RescheduleInput): Promise<Appointment> {
    const now = this.clock.now();
    const appointment = await this.appointments.findByIdOrFail(input.id);

    const before = {
      startsAt: appointment.period.startsAt.toISOString(),
      stylistId: appointment.stylistId,
    };

    if (input.stylistId && input.stylistId !== appointment.stylistId) {
      const target = await this.stylists.findByIdOrFail(input.stylistId);
      if (!target.isBookable()) {
        throw new BusinessRuleViolationError(
          'STYLIST_NOT_BOOKABLE',
          `${target.displayName} no admite reservas`,
        );
      }
      // La misma regla que al reservar: pasarle un balayage a quien no lo hace es reservarlo
      // por la puerta de atrás.
      const unable = appointment.lines.find((line) => !target.canPerform(line.serviceId));
      if (unable) {
        throw new BusinessRuleViolationError(
          'STYLIST_CANNOT_PERFORM_SERVICE',
          `${target.displayName} no realiza uno de los servicios de esta cita`,
          { serviceId: unable.serviceId, stylistId: target.id },
        );
      }
      appointment.reassignTo(input.stylistId, now, input.actorId);
    }

    if (input.startsAt) {
      appointment.rescheduleTo(input.startsAt, now, input.actorId);
    }

    if (!input.force) {
      const stylist = await this.stylists.findByIdOrFail(appointment.stylistId);

      if (!stylist.isWithinWorkingHours(appointment.period, this.salon.timeZone)) {
        throw new BusinessRuleViolationError(
          'OUTSIDE_WORKING_HOURS',
          `El nuevo horario queda fuera de la jornada de ${stylist.displayName}`,
        );
      }

      // La propia cita no cuenta como obstáculo de sí misma: sin excluirla, mover una
      // cita cinco minutos chocaría siempre consigo misma.
      const blocking = await this.appointments.findBlockingInRange(
        appointment.stylistId,
        appointment.period,
        appointment.id,
      );

      if (blocking.length > 0) {
        throw new ConflictError('APPOINTMENT_OVERLAP', 'Ya hay otra cita en esa franja horaria', {
          conflictsWith: blocking.map((other) => other.id),
        });
      }
    }

    const saved = await this.appointments.update(appointment);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Appointment',
      entityId: saved.id,
      before,
      after: {
        startsAt: saved.period.startsAt.toISOString(),
        stylistId: saved.stylistId,
      },
    });

    return saved;
  }
}

export type AppointmentTransition = 'confirm' | 'start' | 'complete' | 'cancel' | 'no-show';

export interface ChangeStatusInput {
  readonly id: string;
  readonly transition: AppointmentTransition;
  readonly reason?: string;
  readonly actorId: string | null;
  /** Si viene, la cita debe pertenecer a este profesional (ámbito `.own`). */
  readonly restrictToStylistId?: string | null;
}

/**
 * Avanza la cita por su ciclo de vida.
 *
 * Un único caso de uso para las cinco transiciones, y no cinco casi idénticos: todas
 * comparten la carga, la comprobación de pertenencia, el guardado y la auditoría. Lo
 * único que cambia es qué método del agregado se invoca, y ahí es donde vive la
 * diferencia de verdad —en la máquina de estados del dominio.
 */
@Injectable()
export class ChangeAppointmentStatusUseCase implements UseCase<ChangeStatusInput, Appointment> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: ChangeStatusInput): Promise<Appointment> {
    const now = this.clock.now();
    const appointment = await this.appointments.findByIdOrFail(input.id);

    if (input.restrictToStylistId) {
      appointment.assertOwnedBy(input.restrictToStylistId);
    }

    const previousStatus = appointment.status;

    switch (input.transition) {
      case 'confirm':
        appointment.confirm(now, input.actorId);
        break;
      case 'start':
        appointment.start(now, input.actorId);
        break;
      case 'complete':
        appointment.complete(now, input.actorId);
        break;
      case 'cancel':
        appointment.cancel(input.reason ?? '', now, input.actorId);
        break;
      case 'no-show':
        appointment.markNoShow(now, input.actorId);
        break;
    }

    const saved = await this.appointments.update(appointment);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Appointment',
      entityId: saved.id,
      before: { status: previousStatus },
      after: { status: saved.status, reason: input.reason ?? null },
    });

    return saved;
  }
}

export interface SearchAppointmentsInput {
  readonly filter: AppointmentFilter;
  readonly page: PageRequest<AppointmentSortField>;
  /** Ámbito `.own`: limita el listado a las citas de este profesional (ADR-0006). */
  readonly restrictToStylistId?: string | null;
}

@Injectable()
export class SearchAppointmentsUseCase implements UseCase<
  SearchAppointmentsInput,
  Page<Appointment>
> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
  ) {}

  execute(input: SearchAppointmentsInput): Promise<Page<Appointment>> {
    // El filtro por profesional se impone **por encima** del que envíe el cliente: quien
    // solo tiene `appointments.read.own` no puede ampliar su alcance manipulando la query.
    const filter: AppointmentFilter = input.restrictToStylistId
      ? { ...input.filter, stylistId: input.restrictToStylistId }
      : input.filter;

    return this.appointments.search(filter, input.page);
  }
}

@Injectable()
export class GetAppointmentUseCase implements UseCase<
  { id: string; restrictToStylistId?: string | null },
  Appointment
> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
  ) {}

  async execute(input: { id: string; restrictToStylistId?: string | null }): Promise<Appointment> {
    const appointment = await this.appointments.findByIdOrFail(input.id);

    if (input.restrictToStylistId) {
      appointment.assertOwnedBy(input.restrictToStylistId);
    }

    return appointment;
  }
}

// ---------------------------------------------------------------------------
// Disponibilidad
// ---------------------------------------------------------------------------

export interface AvailabilityInput {
  /** Sin indicar, se buscan huecos con cualquier profesional que haga los servicios. */
  readonly stylistId?: string;
  /** Día ISO `YYYY-MM-DD` en la zona del salón. */
  readonly date: string;
  readonly serviceIds: readonly string[];
  readonly granularityMinutes?: number;
  readonly minimumNoticeMinutes?: number;
  /**
   * Cita que se está moviendo. Su propio hueco cuenta como libre: sin esto, adelantar una
   * cita quince minutos no aparecería como posible porque choca consigo misma.
   */
  readonly excludeAppointmentId?: string;
  /** Ámbito `.own`: la profesional solo consulta su propia agenda. */
  readonly restrictToStylistId?: string | null;
}

export interface AvailableSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly stylistId: string;
}

/**
 * Huecos concretos en los que se puede reservar.
 *
 * Reúne las tres piezas que hacen falta y que viven en sitios distintos: el horario del
 * profesional (`Stylist`), lo que tarda el servicio (`Service`) y lo que ya está ocupado
 * (`Appointment`). El cálculo en sí lo hace `AvailabilityService`, que no toca la base de
 * datos y por eso se puede probar a fondo.
 *
 * Sin profesional indicada busca en todo el equipo: es la pregunta que hace la clienta por
 * teléfono —«¿qué tenéis el jueves por la tarde?»— y la que la recepción no puede
 * responder mirando una agenda por persona.
 */
@Injectable()
export class GetAvailabilityUseCase implements UseCase<AvailabilityInput, AvailableSlot[]> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(SALON_CONTEXT) private readonly salon: SalonContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: AvailabilityInput): Promise<AvailableSlot[]> {
    const stylistId = input.restrictToStylistId ?? input.stylistId;

    const services = await this.services.findManyByIds(input.serviceIds);
    if (services.length !== new Set(input.serviceIds).size) {
      const found = new Set(services.map((service) => service.id));
      const missing = input.serviceIds.find((id) => !found.has(id));
      throw new EntityNotFoundError('Servicio', missing ?? 'desconocido');
    }

    const canDoAll = (stylist: Stylist) =>
      services.every((service) => stylist.canPerform(service.id));

    let candidates: Stylist[];
    if (stylistId) {
      const stylist = await this.stylists.findByIdOrFail(stylistId);
      if (!stylist.isBookable()) return [];
      if (!canDoAll(stylist)) {
        throw new BusinessRuleViolationError(
          'STYLIST_CANNOT_PERFORM_SERVICE',
          `${stylist.displayName} no realiza alguno de los servicios elegidos`,
          { stylistId: stylist.id },
        );
      }
      candidates = [stylist];
    } else {
      const team = await this.stylists.search(
        { onlyBookable: true },
        { page: 1, limit: 100, sort: [{ field: 'name', direction: 'asc' }] },
      );
      candidates = team.data.filter(canDoAll);
    }

    const day = parseCalendarDay(input.date);
    const working = candidates
      .map((stylist) => ({
        stylist,
        intervals: stylist.workingIntervalsOn(day, this.salon.timeZone),
      }))
      .filter((entry) => entry.intervals.length > 0);
    if (working.length === 0) return [];

    // Una sola consulta para las citas de todo el equipo ese día, no una por profesional.
    const dayRange = TimeRange.create(
      new Date(Math.min(...working.map((entry) => entry.intervals[0].startsAt.getTime()))),
      new Date(Math.max(...working.map((entry) => entry.intervals.at(-1)!.endsAt.getTime()))),
    );
    const booked = await this.appointments.findForCalendar(
      dayRange,
      working.map((entry) => entry.stylist.id),
    );
    const now = this.clock.now();

    const slots = working.flatMap(({ stylist, intervals }) => {
      // La duración que hay que encajar incluye el margen de limpieza de cada servicio:
      // ignorarlo produciría huecos que en la práctica no caben y citas encadenadas sin
      // respiro. Y es la de ESTA profesional: cada una tarda lo suyo.
      const durationMinutes = services.reduce(
        (total, service) =>
          total + stylist.durationFor(service.id, service.durationMinutes) + service.bufferMinutes,
        0,
      );
      const busy = booked
        .filter(
          (appointment) =>
            appointment.stylistId === stylist.id &&
            appointment.isBlocking &&
            appointment.id !== input.excludeAppointmentId,
        )
        .map((appointment) => appointment.period);

      return AvailabilityService.findSlots(intervals, busy, {
        durationMinutes,
        granularityMinutes: input.granularityMinutes ?? 15,
        notBefore: now,
        minimumNoticeMinutes: input.minimumNoticeMinutes ?? 0,
        gridOffsetMs: timeZoneOffsetMs(intervals[0].startsAt, this.salon.timeZone),
      }).map((slot) => ({
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        durationMinutes: slot.durationMinutes,
        stylistId: stylist.id,
      }));
    });

    return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
}

export interface CalendarInput {
  readonly from: Date;
  readonly to: Date;
  readonly stylistIds?: readonly string[];
  readonly restrictToStylistId?: string | null;
}

/** Vista de calendario: todas las citas de un rango, para pintar la parrilla del día. */
@Injectable()
export class GetCalendarUseCase implements UseCase<CalendarInput, Appointment[]> {
  /** Tope de rango: un mes. Pedir un año entero traería decenas de miles de filas. */
  private static readonly MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
  ) {}

  async execute(input: CalendarInput): Promise<Appointment[]> {
    const range = TimeRange.create(input.from, input.to);

    if (input.to.getTime() - input.from.getTime() > GetCalendarUseCase.MAX_RANGE_MS) {
      throw new BusinessRuleViolationError(
        'CALENDAR_RANGE_TOO_WIDE',
        'El rango del calendario no puede superar 31 días',
      );
    }

    const stylistIds = input.restrictToStylistId ? [input.restrictToStylistId] : input.stylistIds;

    return this.appointments.findForCalendar(range, stylistIds);
  }
}

// ---------------------------------------------------------------------------
// Turnos y bloqueos para pintar la parrilla
// ---------------------------------------------------------------------------

export interface ShiftsInput {
  /** Días ISO `YYYY-MM-DD` en la zona del salón, ambos incluidos. */
  readonly from: string;
  readonly to: string;
  readonly stylistIds?: readonly string[];
  readonly restrictToStylistId?: string | null;
}

export interface StylistShifts {
  readonly stylistId: string;
  readonly name: string;
  readonly color: string;
  readonly isBookable: boolean;
  /** Servicios que sabe hacer. Vacío: todos. */
  readonly serviceIds: readonly string[];
  readonly days: readonly {
    readonly date: string;
    readonly intervals: readonly { readonly startsAt: Date; readonly endsAt: Date }[];
  }[];
  readonly blocks: readonly {
    readonly id: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly reason: string | null;
  }[];
}

/**
 * Jornada y bloqueos de cada profesional en un rango de días.
 *
 * Es lo que la parrilla pinta de fondo: lo que no es jornada sale sombreado, y los
 * bloqueos —la comida, una formación— aparecen como tales en lugar de como un hueco libre
 * que nadie puede reservar. Con ámbito propio, la profesional recibe solo su ficha.
 */
@Injectable()
export class GetAgendaShiftsUseCase implements UseCase<ShiftsInput, StylistShifts[]> {
  private static readonly MAX_DAYS = 42;

  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SALON_CONTEXT) private readonly salon: SalonContext,
  ) {}

  async execute(input: ShiftsInput): Promise<StylistShifts[]> {
    const from = parseCalendarDay(input.from);
    const to = parseCalendarDay(input.to);
    const days: CalendarDay[] = [];
    for (let day = from; formatCalendarDay(day) <= formatCalendarDay(to);) {
      days.push(day);
      if (days.length > GetAgendaShiftsUseCase.MAX_DAYS) {
        throw new BusinessRuleViolationError(
          'CALENDAR_RANGE_TOO_WIDE',
          `El rango no puede superar ${GetAgendaShiftsUseCase.MAX_DAYS} días`,
        );
      }
      day = addCalendarDays(day, 1);
    }
    if (days.length === 0) return [];

    let team: Stylist[];
    if (input.restrictToStylistId) {
      const own = await this.stylists.findById(input.restrictToStylistId);
      team = own ? [own] : [];
    } else {
      const page = await this.stylists.search(
        {},
        { page: 1, limit: 100, sort: [{ field: 'name', direction: 'asc' }] },
      );
      const wanted = input.stylistIds?.length ? new Set(input.stylistIds) : null;
      // Las que están de baja definitiva no tienen nada que pintar; las que están de
      // permiso sí, porque pueden tener citas anteriores al permiso.
      team = page.data.filter(
        (stylist) => stylist.status !== 'INACTIVE' && (!wanted || wanted.has(stylist.id)),
      );
    }

    const rangeStart = days[0];
    const rangeEnd = addCalendarDays(days.at(-1)!, 1);
    const rangeStartMs =
      Date.UTC(rangeStart.year, rangeStart.month - 1, rangeStart.day) - 86_400_000;
    const rangeEndMs = Date.UTC(rangeEnd.year, rangeEnd.month - 1, rangeEnd.day) + 86_400_000;

    return team.map((stylist) => ({
      stylistId: stylist.id,
      name: stylist.displayName,
      color: stylist.color,
      isBookable: stylist.isBookable(),
      serviceIds: stylist.skills.map((skill) => skill.serviceId),
      days: days.map((day) => ({
        date: formatCalendarDay(day),
        intervals: stylist.workingIntervalsOn(day, this.salon.timeZone).map((interval) => ({
          startsAt: interval.startsAt,
          endsAt: interval.endsAt,
        })),
      })),
      // El rango se ensancha un día por cada lado: los días se cuentan en la hora del
      // salón y los bloqueos en instantes, y así ninguno del borde se queda fuera.
      blocks: stylist.timeOff
        .filter(
          (block) =>
            block.range.endsAt.getTime() > rangeStartMs &&
            block.range.startsAt.getTime() < rangeEndMs,
        )
        .map((block) => ({
          id: block.id,
          startsAt: block.range.startsAt,
          endsAt: block.range.endsAt,
          reason: block.reason,
        })),
    }));
  }
}

export interface BlockTimeInput {
  readonly stylistId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly reason?: string | null;
  readonly actorId: string | null;
}

/**
 * Bloquea un tramo de la agenda de una profesional: la comida, una formación, un recado.
 *
 * Por debajo es una ausencia, que es lo que el cálculo de huecos ya sabe respetar. La
 * diferencia con dar de alta una ausencia en la ficha es que aquí **no se permite tapar
 * citas**: bloquear encima de una clienta reservada la dejaría fuera de horario sin que
 * nadie la avise. Primero se mueve la cita; después se bloquea.
 */
@Injectable()
export class BlockStylistTimeUseCase implements UseCase<BlockTimeInput, { id: string }> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: BlockTimeInput): Promise<{ id: string }> {
    const range = TimeRange.create(input.startsAt, input.endsAt);
    if (range.durationMinutes > 24 * 60) {
      throw new BusinessRuleViolationError(
        'BLOCK_TOO_LONG',
        'Un bloqueo de agenda dura como mucho un día. Para vacaciones, registre una ausencia.',
      );
    }

    const stylist = await this.stylists.findByIdOrFail(input.stylistId);
    const clashing = await this.appointments.findBlockingInRange(stylist.id, range);
    if (clashing.length > 0) {
      throw new ConflictError(
        'BLOCK_OVERLAPS_APPOINTMENTS',
        `${stylist.displayName} tiene citas en ese tramo. Muévalas antes de bloquearlo.`,
        { conflictsWith: clashing.map((appointment) => appointment.id) },
      );
    }

    const id = this.ids.generate();
    const now = this.clock.now();
    stylist.addTimeOff({ id, range, reason: input.reason?.trim() || null }, now, input.actorId);
    await this.stylists.update(stylist);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'StylistTimeOff',
      entityId: id,
      after: {
        stylistId: stylist.id,
        startsAt: range.startsAt.toISOString(),
        endsAt: range.endsAt.toISOString(),
        reason: input.reason ?? null,
        source: 'agenda',
      },
    });
    this.events.publish({
      tenantId: stylist.tenantId,
      kind: 'block',
      stylistIds: [stylist.id],
      at: now,
    });

    return { id };
  }
}

@Injectable()
export class RemoveStylistBlockUseCase implements UseCase<
  { stylistId: string; blockId: string; actorId: string | null },
  void
> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: { stylistId: string; blockId: string; actorId: string | null }) {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);
    const now = this.clock.now();
    stylist.removeTimeOff(input.blockId, now, input.actorId);
    await this.stylists.update(stylist);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'StylistTimeOff',
      entityId: input.blockId,
      metadata: { stylistId: stylist.id, source: 'agenda' },
    });
    this.events.publish({
      tenantId: stylist.tenantId,
      kind: 'block',
      stylistIds: [stylist.id],
      at: now,
    });
  }
}

export interface UpdateNotesInput {
  readonly id: string;
  readonly notes?: string | null;
  readonly internalNotes?: string | null;
  readonly actorId: string | null;
  readonly restrictToStylistId?: string | null;
}

/**
 * Notas de la cita. Editables incluso terminada: es donde se apunta la fórmula de color que
 * se usó, y eso a veces se recuerda después.
 */
@Injectable()
export class UpdateAppointmentNotesUseCase implements UseCase<UpdateNotesInput, Appointment> {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: UpdateNotesInput): Promise<Appointment> {
    const appointment = await this.appointments.findByIdOrFail(input.id);
    if (input.restrictToStylistId) appointment.assertOwnedBy(input.restrictToStylistId);

    appointment.updateNotes(
      {
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(input.internalNotes !== undefined
          ? { internalNotes: input.internalNotes?.trim() || null }
          : {}),
      },
      this.clock.now(),
      input.actorId,
    );

    return this.appointments.update(appointment);
  }
}

/** Día de calendario del salón en el que cae un instante. Lo usan los informes. */
export const salonDayOf = (instant: Date, timeZone: string): string => {
  const day = instantToCalendarDay(instant, timeZone);
  return `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
};
