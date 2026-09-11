import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
} from '../../../../shared/domain/ports/repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import { TimeRange } from '../../../../shared/domain/value-objects/time-range.vo';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { Appointment, BLOCKING_STATUSES } from '../../domain/appointment.entity';
import type {
  AppointmentFilter,
  AppointmentRepository,
  AppointmentSortField,
} from '../../domain/appointment.repository';

const APPOINTMENT_INCLUDE = {
  services: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.AppointmentInclude;

type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof APPOINTMENT_INCLUDE }>;

/**
 * Adaptador Prisma de la agenda.
 *
 * Su consulta más importante es `findBlockingInRange`: alimenta tanto el cálculo de
 * huecos como la comprobación previa a reservar, y se ejecuta varias veces por cada
 * pantalla de calendario. Se apoya en el índice parcial `appointments_active_calendar_idx`,
 * que solo indexa las citas vivas que ocupan sillón y por eso se mantiene pequeño y
 * caliente.
 */
@Injectable()
export class PrismaAppointmentRepository
  extends PrismaRepositoryBase<Appointment, AppointmentRow, AppointmentFilter, AppointmentSortField>
  implements AppointmentRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'appointment';
  protected readonly entityName = 'Cita';

  protected readonly sortableFields: ReadonlyMap<
    AppointmentSortField,
    OrderByClause | OrderByClause[]
  > = new Map<AppointmentSortField, OrderByClause | OrderByClause[]>([
    ['startsAt', { startsAt: true }],
    ['createdAt', { createdAt: true }],
    ['status', [{ status: true }, { startsAt: true }]],
  ]);

  protected readonly defaultSort = [{ field: 'startsAt' as const, direction: 'asc' as const }];

  // -- Lecturas -------------------------------------------------------------

  override async findById(id: string, options?: QueryOptions): Promise<Appointment | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.appointment.findFirst({ where: { id }, include: APPOINTMENT_INCLUDE }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  /**
   * Citas que ocupan sillón y se solapan con el intervalo.
   *
   * El solapamiento se expresa como `startsAt < fin AND endsAt > inicio`, que es la
   * traducción exacta de la semántica semiabierta `[inicio, fin)`. Con `<=` en cualquiera
   * de los dos extremos, dos citas consecutivas —10:00-11:00 y 11:00-12:00— se
   * considerarían solapadas y el sistema rechazaría la reserva más frecuente de una
   * peluquería.
   */
  async findBlockingInRange(
    stylistId: string,
    range: TimeRange,
    excludeAppointmentId?: string,
  ): Promise<Appointment[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.appointment.findMany({
        where: {
          stylistId,
          status: { in: [...BLOCKING_STATUSES] },
          startsAt: { lt: range.endsAt },
          endsAt: { gt: range.startsAt },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        },
        include: APPOINTMENT_INCLUDE,
        orderBy: { startsAt: 'asc' },
      }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  async findForCalendar(range: TimeRange, stylistIds?: readonly string[]): Promise<Appointment[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.appointment.findMany({
        where: {
          startsAt: { lt: range.endsAt },
          endsAt: { gt: range.startsAt },
          ...(stylistIds && stylistIds.length > 0 ? { stylistId: { in: [...stylistIds] } } : {}),
        },
        include: APPOINTMENT_INCLUDE,
        orderBy: [{ startsAt: 'asc' }, { stylistId: 'asc' }],
      }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  override async search(
    filter: AppointmentFilter,
    page: PageRequest<AppointmentSortField>,
    options?: QueryOptions,
  ): Promise<Page<Appointment>> {
    const where = this.buildWhere(filter);
    const orderBy = this.buildOrderBy(page.sort);

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.prisma.client.appointment.count({ where }),
          this.prisma.client.appointment.findMany({
            where,
            orderBy,
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: APPOINTMENT_INCLUDE,
          }),
        ]),
      ),
    );

    return buildPage(
      rows.map((row) => this.toDomain(row)),
      total,
      page,
    );
  }

  // -- Escrituras -----------------------------------------------------------

  async create(appointment: Appointment): Promise<Appointment> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.appointment.create({
        data: {
          id: appointment.id,
          tenantId: appointment.tenantId,
          ...this.toPersistence(appointment),
          createdAt: appointment.audit.createdAt,
          updatedAt: appointment.audit.updatedAt,
          createdBy: appointment.audit.createdBy,
          updatedBy: appointment.audit.updatedBy,
          services: {
            // `tenantId` explícito: las escrituras anidadas no pasan por la extensión que
            // lo inyecta, y sin él las líneas quedarían huérfanas de salón.
            create: appointment.lines.map((line) => ({
              id: line.id,
              tenantId: appointment.tenantId,
              serviceId: line.serviceId,
              durationMinutes: line.durationMinutes,
              price: line.price.toDecimalString(),
              currency: line.price.currency,
              sortOrder: line.sortOrder,
            })),
          },
        },
        include: APPOINTMENT_INCLUDE,
      }),
    );

    return this.toDomain(row);
  }

  async update(appointment: Appointment): Promise<Appointment> {
    return this.prisma.transaction(async () => {
      const result = await withMappedErrors(this.entityName, () =>
        this.prisma.client.appointment.updateMany({
          where: { id: appointment.id },
          data: {
            ...this.toPersistence(appointment),
            updatedAt: appointment.audit.updatedAt,
            updatedBy: appointment.audit.updatedBy,
          },
        }),
      );

      if (result.count === 0) {
        throw new EntityNotFoundError(this.entityName, appointment.id);
      }

      await this.prisma.client.appointmentService.deleteMany({
        where: { appointmentId: appointment.id },
      });
      await this.prisma.client.appointmentService.createMany({
        data: appointment.lines.map((line) => ({
          id: line.id,
          tenantId: appointment.tenantId,
          appointmentId: appointment.id,
          serviceId: line.serviceId,
          durationMinutes: line.durationMinutes,
          price: line.price.toDecimalString(),
          currency: line.price.currency,
          sortOrder: line.sortOrder,
        })),
      });

      const row = await this.prisma.client.appointment.findFirst({
        where: { id: appointment.id },
        include: APPOINTMENT_INCLUDE,
      });

      if (!row) throw new EntityNotFoundError(this.entityName, appointment.id);
      return this.toDomain(row);
    });
  }

  async save(appointment: Appointment): Promise<Appointment> {
    return this.update(appointment);
  }

  // -- Filtro ---------------------------------------------------------------

  protected buildWhere(filter: AppointmentFilter): Record<string, unknown> {
    return this.compose(
      filter.stylistId ? { stylistId: filter.stylistId } : undefined,
      filter.clientId ? { clientId: filter.clientId } : undefined,
      filter.status ? { status: filter.status } : undefined,
      filter.onlyBlocking ? { status: { in: [...BLOCKING_STATUSES] } } : undefined,
      // El rango usa la misma semántica de solapamiento que `findBlockingInRange`: una
      // cita que empieza antes del rango pero termina dentro debe aparecer en la vista.
      filter.from ? { endsAt: { gt: filter.from } } : undefined,
      filter.to ? { startsAt: { lt: filter.to } } : undefined,
      this.textSearch(filter.search, ['notes', 'internalNotes']),
    );
  }

  // -- Mapeo ----------------------------------------------------------------

  private toPersistence(appointment: Appointment) {
    return {
      clientId: appointment.clientId,
      stylistId: appointment.stylistId,
      startsAt: appointment.period.startsAt,
      endsAt: appointment.period.endsAt,
      status: appointment.status,
      source: appointment.source,
      notes: appointment.notes,
      internalNotes: appointment.internalNotes,
      confirmedAt: appointment.confirmedAt,
      startedAt: appointment.startedAt,
      completedAt: appointment.completedAt,
      cancelledAt: appointment.cancelledAt,
      cancelledBy: appointment.cancelledBy,
      cancellationReason: appointment.cancellationReason,
      noShowAt: appointment.noShowAt,
      reminderSentAt: appointment.reminderSentAt,
      estimatedTotal: appointment.estimatedTotal.toDecimalString(),
      currency: appointment.currency,
      deletedAt: appointment.audit.deletedAt,
      deletedBy: appointment.audit.deletedBy,
    };
  }

  protected toDomain(row: AppointmentRow): Appointment {
    return Appointment.rehydrate(row.id, {
      tenantId: row.tenantId,
      clientId: row.clientId,
      stylistId: row.stylistId,
      period: TimeRange.create(row.startsAt, row.endsAt),
      status: row.status,
      source: row.source,
      notes: row.notes,
      internalNotes: row.internalNotes,
      lines: row.services.map((line) => ({
        id: line.id,
        serviceId: line.serviceId,
        durationMinutes: line.durationMinutes,
        price: Money.fromDecimal(line.price.toFixed(2), line.currency),
        sortOrder: line.sortOrder,
      })),
      currency: row.currency,
      confirmedAt: row.confirmedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      cancelledBy: row.cancelledBy,
      cancellationReason: row.cancellationReason,
      noShowAt: row.noShowAt,
      reminderSentAt: row.reminderSentAt,
      audit: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        deletedBy: row.deletedBy,
      },
    });
  }
}
