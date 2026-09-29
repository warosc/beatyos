import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { ConflictError } from '../../../../shared/domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
} from '../../../../shared/domain/ports/repository.port';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { ServiceTicket } from '../../domain/service-ticket.entity';
import type {
  ServiceTicketFilter,
  ServiceTicketRepository,
  ServiceTicketSortField,
} from '../../domain/service-ticket.repository';

const TICKET_INCLUDE = {
  lines: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.ServiceTicketInclude;

type TicketWithLines = Prisma.ServiceTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

@Injectable()
export class PrismaServiceTicketRepository
  extends PrismaRepositoryBase<
    ServiceTicket,
    TicketWithLines,
    ServiceTicketFilter,
    ServiceTicketSortField
  >
  implements ServiceTicketRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'serviceTicket';
  protected readonly entityName = 'Comanda';

  protected readonly sortableFields: ReadonlyMap<
    ServiceTicketSortField,
    OrderByClause | OrderByClause[]
  > = new Map<ServiceTicketSortField, OrderByClause | OrderByClause[]>([
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort = [{ field: 'createdAt' as const, direction: 'desc' as const }];

  override async findById(id: string, options?: QueryOptions): Promise<ServiceTicket | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.serviceTicket.findFirst({ where: { id }, include: TICKET_INCLUDE }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findActiveByAppointmentId(appointmentId: string): Promise<ServiceTicket | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.serviceTicket.findFirst({
        where: { appointmentId, status: { not: 'CANCELLED' } },
        include: TICKET_INCLUDE,
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  override async search(
    filter: ServiceTicketFilter,
    page: PageRequest<ServiceTicketSortField>,
    options?: QueryOptions,
  ): Promise<Page<ServiceTicket>> {
    const where = this.buildWhere(filter);

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.prisma.client.serviceTicket.count({ where }),
          this.prisma.client.serviceTicket.findMany({
            where,
            orderBy: this.buildOrderBy(page.sort),
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: TICKET_INCLUDE,
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

  /** Cabecera y servicios en una sola escritura anidada: no hay comanda sin servicios. */
  async create(ticket: ServiceTicket): Promise<ServiceTicket> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.serviceTicket.create({
        data: {
          id: ticket.id,
          tenantId: ticket.tenantId,
          stylistId: ticket.stylistId,
          clientId: ticket.clientId,
          clientName: ticket.clientName,
          appointmentId: ticket.appointmentId,
          notes: ticket.notes,
          ...this.toPersistence(ticket),
          createdAt: ticket.audit.createdAt,
          updatedAt: ticket.audit.updatedAt,
          createdBy: ticket.audit.createdBy,
          updatedBy: ticket.audit.updatedBy,
          lines: {
            create: ticket.serviceIds.map((serviceId, index) => ({
              tenantId: ticket.tenantId,
              serviceId,
              sortOrder: index,
            })),
          },
        },
        include: TICKET_INCLUDE,
      }),
    );

    return this.toDomain(row);
  }

  async update(ticket: ServiceTicket): Promise<ServiceTicket> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.serviceTicket.updateMany({
        where: { id: ticket.id, status: 'PENDING' },
        data: {
          ...this.toPersistence(ticket),
          updatedAt: ticket.audit.updatedAt,
          updatedBy: ticket.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new ConflictError(
        'SERVICE_TICKET_NOT_PENDING',
        'Esta comanda ya no está pendiente: otra persona la cobró o la anuló. Actualice la lista.',
        { ticketId: ticket.id },
      );
    }

    return this.findByIdOrFail(ticket.id);
  }

  async save(ticket: ServiceTicket): Promise<ServiceTicket> {
    return this.update(ticket);
  }

  protected buildWhere(filter: ServiceTicketFilter): Record<string, unknown> {
    const createdAt =
      filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: filter.to } : {}),
            },
          }
        : undefined;

    return this.compose(
      filter.stylistId ? { stylistId: filter.stylistId } : undefined,
      filter.status ? { status: filter.status } : undefined,
      createdAt,
    );
  }

  /** Lo que puede cambiar tras crearla. Cliente, profesional y servicios son fijos. */
  private toPersistence(ticket: ServiceTicket) {
    return {
      status: ticket.status,
      invoiceId: ticket.invoiceId,
      chargedAt: ticket.chargedAt,
      chargedBy: ticket.chargedBy,
      cancelledAt: ticket.cancelledAt,
      cancelledBy: ticket.cancelledBy,
      cancellationReason: ticket.cancellationReason,
      deletedAt: ticket.audit.deletedAt,
      deletedBy: ticket.audit.deletedBy,
    };
  }

  protected toDomain(row: TicketWithLines): ServiceTicket {
    return ServiceTicket.rehydrate(row.id, {
      tenantId: row.tenantId,
      stylistId: row.stylistId,
      clientId: row.clientId,
      clientName: row.clientName,
      appointmentId: row.appointmentId,
      invoiceId: row.invoiceId,
      status: row.status,
      serviceIds: row.lines.map((line) => line.serviceId),
      notes: row.notes,
      chargedAt: row.chargedAt,
      chargedBy: row.chargedBy,
      cancelledAt: row.cancelledAt,
      cancelledBy: row.cancelledBy,
      cancellationReason: row.cancellationReason,
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
