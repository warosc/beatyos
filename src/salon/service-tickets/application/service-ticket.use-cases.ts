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
  DomainValidationError,
  EntityNotFoundError,
} from '../../../shared/domain/errors';
import {
  buildPage,
  UNIT_OF_WORK,
  type Page,
  type PageRequest,
  type UnitOfWork,
} from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import type { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import type { Appointment } from '../../appointments/domain/appointment.entity';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
} from '../../appointments/domain/appointment.repository';
import {
  SERVICE_REPOSITORY,
  type ServiceRepository,
} from '../../catalog/domain/catalog.repositories';
import type { Service } from '../../catalog/domain/service.entity';
import { CLIENT_REPOSITORY, type ClientRepository } from '../../clients/domain/client.repository';
import {
  RegisterSaleUseCase,
  type SalePaymentInput,
} from '../../sales/application/sales.use-cases';
import { buildInvoiceLine, type Invoice } from '../../sales/domain/invoice.entity';
import type { Payment } from '../../sales/domain/payment.entity';
import { INVOICE_REPOSITORY, type InvoiceRepository } from '../../sales/domain/sales.repositories';
import type { Stylist } from '../../stylists/domain/stylist.entity';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import { ServiceTicket } from '../domain/service-ticket.entity';
import {
  SERVICE_TICKET_REPOSITORY,
  type ServiceTicketFilter,
  type ServiceTicketRepository,
  type ServiceTicketSortField,
} from '../domain/service-ticket.repository';

// ===========================================================================
// Registrar el servicio realizado
// ===========================================================================

export interface RegisterServiceTicketInput {
  readonly tenantId: string;
  readonly stylistId: string;
  readonly serviceIds: readonly string[];
  readonly clientId?: string | null;
  /** Solo para la clienta de paso, sin ficha. Con `clientId` se usa el nombre de la ficha. */
  readonly clientName?: string | null;
  readonly appointmentId?: string | null;
  readonly notes?: string | null;
  readonly actorId: string;
}

/**
 * La profesional declara lo que ha hecho y caja lo recibe como pendiente de cobro.
 *
 * Solo admite servicios que la administración ha dejado preparados: activos en el catálogo
 * y, si la profesional tiene habilidades asignadas, entre ellas. Es la misma regla que
 * decide si se le puede agendar una cita, así que lo que puede declarar coincide con lo que
 * puede hacer.
 *
 * Si la comanda sale de una cita, la cita queda completada en la misma transacción: es el
 * mismo hecho —la clienta ya fue atendida— y dejarlo en dos pasos invitaría a olvidar uno.
 */
@Injectable()
export class RegisterServiceTicketUseCase implements UseCase<
  RegisterServiceTicketInput,
  ServiceTicket
> {
  constructor(
    @Inject(SERVICE_TICKET_REPOSITORY) private readonly tickets: ServiceTicketRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(APPOINTMENT_REPOSITORY) private readonly appointments: AppointmentRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: RegisterServiceTicketInput): Promise<ServiceTicket> {
    const created = await this.uow.execute(async () => {
      const now = this.clock.now();
      const stylist = await this.stylists.findByIdOrFail(input.stylistId);

      if (!stylist.isBookable()) {
        throw new BusinessRuleViolationError(
          'STYLIST_NOT_ACTIVE',
          `${stylist.displayName} no está activa y no puede registrar servicios`,
          { stylistId: stylist.id },
        );
      }

      const appointment = input.appointmentId
        ? await this.loadAttendableAppointment(input.appointmentId, stylist)
        : null;

      if (appointment && input.clientId && input.clientId !== appointment.clientId) {
        throw new DomainValidationError('La clienta no coincide con la de la cita', 'clientId');
      }

      const clientId = input.clientId ?? appointment?.clientId ?? null;
      const clientName = clientId
        ? (await this.clients.findByIdOrFail(clientId)).name.full
        : (input.clientName ?? '');

      await this.assertAssignable(input.serviceIds, stylist);

      const ticket = ServiceTicket.register({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        stylistId: stylist.id,
        clientId,
        clientName,
        appointmentId: appointment?.id ?? null,
        serviceIds: input.serviceIds,
        notes: input.notes ?? null,
        now,
        actorId: input.actorId,
      });

      const saved = await this.tickets.create(ticket);

      if (appointment && appointment.status !== 'COMPLETED') {
        closeAppointment(appointment, now, input.actorId);
        await this.appointments.update(appointment);
      }

      return saved;
    });

    await this.audit.record({
      action: 'CREATE',
      entityType: 'ServiceTicket',
      entityId: created.id,
      after: {
        stylistId: created.stylistId,
        clientId: created.clientId,
        appointmentId: created.appointmentId,
        services: created.serviceIds.length,
      },
    });

    return created;
  }

  private async loadAttendableAppointment(
    appointmentId: string,
    stylist: Stylist,
  ): Promise<Appointment> {
    const appointment = await this.appointments.findByIdOrFail(appointmentId);

    if (appointment.stylistId !== stylist.id) {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_OF_ANOTHER_STYLIST',
        'Esa cita está asignada a otra profesional',
        { appointmentId },
      );
    }
    if (appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW') {
      throw new BusinessRuleViolationError(
        'APPOINTMENT_NOT_ATTENDED',
        'La cita está cancelada o marcada como no presentada',
        { appointmentId, status: appointment.status },
      );
    }

    const existing = await this.tickets.findActiveByAppointmentId(appointmentId);
    if (existing) {
      throw new ConflictError(
        'APPOINTMENT_ALREADY_REGISTERED',
        'Los servicios de esta cita ya se registraron',
        { appointmentId, ticketId: existing.id },
      );
    }

    const invoice = await this.invoices.findByAppointmentId(appointmentId);
    if (invoice) {
      throw new ConflictError(
        'APPOINTMENT_ALREADY_INVOICED',
        `Esa cita ya se cobró en el documento ${invoice.number}`,
        { invoiceId: invoice.id, number: invoice.number },
      );
    }

    return appointment;
  }

  private async assertAssignable(serviceIds: readonly string[], stylist: Stylist): Promise<void> {
    const services = await this.services.findManyByIds(serviceIds);
    const byId = new Map(services.map((service) => [service.id, service]));

    for (const serviceId of serviceIds) {
      const service = byId.get(serviceId);
      if (!service) throw new EntityNotFoundError('Servicio', serviceId);

      if (!service.isActive) {
        throw new BusinessRuleViolationError(
          'ITEM_NOT_AVAILABLE',
          `${service.name} está dado de baja y no se puede registrar`,
          { serviceId },
        );
      }
      if (!stylist.canPerform(serviceId)) {
        throw new BusinessRuleViolationError(
          'SERVICE_NOT_ASSIGNED',
          `${service.name} no está entre los servicios asignados a ${stylist.displayName}`,
          { serviceId, stylistId: stylist.id },
        );
      }
    }
  }
}

/**
 * Completa la cita recorriendo la máquina de estados normal.
 *
 * Si nadie pulsó «empezar», el inicio se fija a la hora prevista —o a ahora, si la
 * profesional adelantó la visita—, con el mismo criterio que `Appointment.complete`.
 */
const closeAppointment = (appointment: Appointment, now: Date, actorId: string): void => {
  if (appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED') {
    const plannedStart = appointment.period.startsAt;
    appointment.start(plannedStart.getTime() < now.getTime() ? plannedStart : now, actorId);
  }
  appointment.complete(now, actorId);
};

// ===========================================================================
// Cobrar en caja
// ===========================================================================

export interface ChargeServiceTicketInput {
  readonly ticketId: string;
  readonly tenantId: string;
  readonly currency: string;
  readonly payments: readonly SalePaymentInput[];
  readonly actorId: string;
}

export interface ChargeServiceTicketResult {
  readonly ticket: ServiceTicket;
  readonly invoice: Invoice;
  readonly payments: readonly Payment[];
}

/**
 * Cobra una comanda: emite la factura con `RegisterSaleUseCase` y marca la comanda cobrada.
 *
 * No calcula nada por su cuenta. Precio, impuesto, comisión de la profesional, cobro en
 * efectivo contra la caja abierta y visita en la ficha de la clienta salen de la venta de
 * siempre; esta clase solo traduce la comanda a líneas y cierra la comanda **dentro** de la
 * misma transacción que la factura.
 */
@Injectable()
export class ChargeServiceTicketUseCase implements UseCase<
  ChargeServiceTicketInput,
  ChargeServiceTicketResult
> {
  constructor(
    @Inject(SERVICE_TICKET_REPOSITORY) private readonly tickets: ServiceTicketRepository,
    private readonly registerSale: RegisterSaleUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: ChargeServiceTicketInput): Promise<ChargeServiceTicketResult> {
    const ticket = await this.tickets.findByIdOrFail(input.ticketId);

    // Se comprueba antes de facturar para dar un mensaje claro. La garantía real la da
    // `update`, que solo escribe si la comanda sigue pendiente en la base.
    if (!ticket.isPending) {
      throw new ConflictError(
        'SERVICE_TICKET_NOT_PENDING',
        ticket.status === 'CHARGED'
          ? 'Esta comanda ya está cobrada'
          : 'Esta comanda está anulada y no se puede cobrar',
        { ticketId: ticket.id, status: ticket.status },
      );
    }

    let charged = ticket;
    const sale = await this.registerSale.execute(
      {
        tenantId: input.tenantId,
        currency: input.currency,
        clientId: ticket.clientId,
        appointmentId: ticket.appointmentId,
        lines: ticket.serviceIds.map((serviceId) => ({
          kind: 'SERVICE' as const,
          itemId: serviceId,
          quantity: 1,
          stylistId: ticket.stylistId,
        })),
        payments: input.payments,
        actorId: input.actorId,
      },
      async ({ invoice }) => {
        ticket.markCharged(invoice.id, this.clock.now(), input.actorId);
        charged = await this.tickets.update(ticket);
      },
    );

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'ServiceTicket',
      entityId: charged.id,
      after: { status: 'CHARGED', invoiceId: sale.invoice.id, number: sale.invoice.number },
    });

    return { ticket: charged, invoice: sale.invoice, payments: sale.payments };
  }
}

// ===========================================================================
// Anular
// ===========================================================================

export interface CancelServiceTicketInput {
  readonly ticketId: string;
  readonly reason: string;
  readonly actorId: string;
  /** Con `service-tickets.cancel.own`: solo las comandas de esta profesional. */
  readonly restrictToStylistId: string | null;
}

@Injectable()
export class CancelServiceTicketUseCase implements UseCase<
  CancelServiceTicketInput,
  ServiceTicket
> {
  constructor(
    @Inject(SERVICE_TICKET_REPOSITORY) private readonly tickets: ServiceTicketRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CancelServiceTicketInput): Promise<ServiceTicket> {
    const ticket = await this.tickets.findByIdOrFail(input.ticketId);

    // La comanda de otra profesional se trata como inexistente, igual que una cita ajena:
    // un 403 confirmaría que el identificador existe.
    if (input.restrictToStylistId && ticket.stylistId !== input.restrictToStylistId) {
      throw new EntityNotFoundError('Comanda', input.ticketId);
    }

    ticket.cancel(input.reason, this.clock.now(), input.actorId);
    const cancelled = await this.tickets.update(ticket);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'ServiceTicket',
      entityId: cancelled.id,
      after: { status: 'CANCELLED', reason: cancelled.cancellationReason },
    });

    return cancelled;
  }
}

// ===========================================================================
// Consultas
// ===========================================================================

export interface ServiceTicketLineView {
  readonly serviceId: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly taxRate: Percentage | null;
  readonly lineTotal: Money;
  /** `false` si el servicio se retiró del catálogo después: la comanda ya no se puede cobrar. */
  readonly available: boolean;
}

export interface ServiceTicketView {
  readonly ticket: ServiceTicket;
  readonly stylistName: string;
  readonly lines: readonly ServiceTicketLineView[];
  /** Lo que se cobraría ahora. Sale de la misma aritmética que la factura. */
  readonly total: Money;
}

export interface ListServiceTicketsInput {
  readonly filter: ServiceTicketFilter;
  readonly page: PageRequest<ServiceTicketSortField>;
  readonly currency: string;
  /** Con `service-tickets.read.own`: se impone por encima de cualquier filtro recibido. */
  readonly restrictToStylistId: string | null;
}

/**
 * Lista comandas con lo que caja necesita para cobrar: nombres e importe.
 *
 * El importe se calcula con `buildInvoiceLine`, la misma regla que usará la factura. Así lo
 * que caja ve es exactamente lo que se le pedirá cobrar; una fórmula paralela aquí acabaría
 * discrepando un céntimo con el primer cambio de impuesto.
 */
@Injectable()
export class ListServiceTicketsUseCase implements UseCase<
  ListServiceTicketsInput,
  Page<ServiceTicketView>
> {
  constructor(
    @Inject(SERVICE_TICKET_REPOSITORY) private readonly tickets: ServiceTicketRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
  ) {}

  async execute(input: ListServiceTicketsInput): Promise<Page<ServiceTicketView>> {
    const filter = input.restrictToStylistId
      ? { ...input.filter, stylistId: input.restrictToStylistId }
      : input.filter;
    const page = await this.tickets.search(filter, input.page);

    return buildPage(await this.describe(page.data, input.currency), page.meta.total, input.page);
  }

  /** Añade nombres e importes a comandas ya cargadas. */
  async describe(
    tickets: readonly ServiceTicket[],
    currency: string,
  ): Promise<ServiceTicketView[]> {
    const serviceIds = [...new Set(tickets.flatMap((ticket) => ticket.serviceIds))];
    const stylistIds = [...new Set(tickets.map((ticket) => ticket.stylistId))];

    const [services, stylists] = await Promise.all([
      this.services.findManyByIds(serviceIds),
      // Un salón tiene un puñado de profesionales: no justifica un `findManyByIds` propio.
      Promise.all(stylistIds.map((id) => this.stylists.findById(id))),
    ]);

    const servicesById = new Map(services.map((service) => [service.id, service]));
    const namesById = new Map(
      stylists.filter((s) => s !== null).map((stylist) => [stylist.id, stylist.displayName]),
    );

    return tickets.map((ticket) => {
      const lines = ticket.serviceIds.map((serviceId) =>
        toLineView(serviceId, servicesById.get(serviceId), currency),
      );
      return {
        ticket,
        stylistName: namesById.get(ticket.stylistId) ?? 'Profesional',
        lines,
        total: Money.sum(
          lines.map((line) => line.lineTotal),
          currency,
        ),
      };
    });
  }
}

const toLineView = (
  serviceId: string,
  service: Service | undefined,
  currency: string,
): ServiceTicketLineView => {
  if (!service || !service.isActive) {
    return {
      serviceId,
      name: service?.name ?? 'Servicio retirado del catálogo',
      unitPrice: Money.zero(currency),
      taxRate: null,
      lineTotal: Money.zero(currency),
      available: false,
    };
  }

  const line = buildInvoiceLine({
    id: serviceId,
    kind: 'SERVICE',
    description: service.name,
    quantity: 1,
    unitPrice: service.price,
    taxRate: service.taxRate,
  });

  return {
    serviceId,
    name: service.name,
    unitPrice: service.price,
    taxRate: service.taxRate,
    lineTotal: line.lineTotal,
    available: true,
  };
};

// ---------------------------------------------------------------------------

/**
 * Servicios que una profesional puede declarar: los activos del catálogo que tiene
 * asignados. Sin asignaciones, todos —igual que en la agenda—.
 */
@Injectable()
export class ListAssignableServicesUseCase implements UseCase<{ stylistId: string }, Service[]> {
  constructor(
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
  ) {}

  async execute(input: { stylistId: string }): Promise<Service[]> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);
    const catalog = await this.services.search(
      { isActive: true },
      { page: 1, limit: 500, sort: [{ field: 'name', direction: 'asc' }] },
    );
    return catalog.data.filter((service) => stylist.canPerform(service.id));
  }
}
