import {
  BusinessRuleViolationError,
  ConflictError,
  EntityNotFoundError,
} from '@shared/domain/errors';
import { buildPage, type Page, type PageRequest } from '@shared/domain/ports/repository.port';
import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import { Money } from '@shared/domain/value-objects/money.vo';
import { PersonName } from '@shared/domain/value-objects/contact.vo';
import { InMemoryAuditRecorder } from '@test/doubles/auth.doubles';
import {
  InMemoryAppointmentRepository,
  InMemoryServiceRepository,
  InMemoryStylistRepository,
  passthroughUnitOfWork,
} from '@test/doubles/salon.doubles';
import { Appointment } from '@salon/appointments/domain/appointment.entity';
import { Service } from '@salon/catalog/domain/service.entity';
import type { ClientRepository } from '@salon/clients/domain/client.repository';
import type {
  RegisterSaleInput,
  RegisterSaleResult,
  RegisterSaleUseCase,
  WithinSaleTransaction,
} from '@salon/sales/application/sales.use-cases';
import type { Invoice } from '@salon/sales/domain/invoice.entity';
import type { InvoiceRepository } from '@salon/sales/domain/sales.repositories';
import { Stylist } from '@salon/stylists/domain/stylist.entity';

import { ServiceTicket } from '../domain/service-ticket.entity';
import type {
  ServiceTicketFilter,
  ServiceTicketRepository,
  ServiceTicketSortField,
} from '../domain/service-ticket.repository';
import {
  CancelServiceTicketUseCase,
  ChargeServiceTicketUseCase,
  ListAssignableServicesUseCase,
  ListServiceTicketsUseCase,
  RegisterServiceTicketUseCase,
} from './service-ticket.use-cases';

/**
 * Doble en memoria con la misma garantía que el adaptador Prisma: `update` solo escribe si
 * la comanda sigue pendiente.
 */
class InMemoryServiceTicketRepository implements ServiceTicketRepository {
  readonly items = new Map<string, ServiceTicket>();
  private readonly persistedStatus = new Map<string, string>();

  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByIdOrFail(id: string) {
    const ticket = this.items.get(id);
    if (!ticket) throw new EntityNotFoundError('Comanda', id);
    return ticket;
  }
  async exists(id: string) {
    return this.items.has(id);
  }
  async count(filter: ServiceTicketFilter) {
    return this.filtered(filter).length;
  }
  async findActiveByAppointmentId(appointmentId: string) {
    return (
      [...this.items.values()].find(
        (t) => t.appointmentId === appointmentId && t.status !== 'CANCELLED',
      ) ?? null
    );
  }
  async search(
    filter: ServiceTicketFilter,
    page: PageRequest<ServiceTicketSortField>,
  ): Promise<Page<ServiceTicket>> {
    const rows = this.filtered(filter);
    return buildPage(rows, rows.length, page);
  }
  async create(ticket: ServiceTicket) {
    this.items.set(ticket.id, ticket);
    this.persistedStatus.set(ticket.id, ticket.status);
    return ticket;
  }
  async update(ticket: ServiceTicket) {
    if (this.persistedStatus.get(ticket.id) !== 'PENDING') {
      throw new ConflictError('SERVICE_TICKET_NOT_PENDING', 'Ya no está pendiente');
    }
    this.items.set(ticket.id, ticket);
    this.persistedStatus.set(ticket.id, ticket.status);
    return ticket;
  }
  async save(ticket: ServiceTicket) {
    return this.update(ticket);
  }
  async softDelete() {}
  async restore(id: string) {
    return this.findByIdOrFail(id);
  }
  private filtered(filter: ServiceTicketFilter) {
    return [...this.items.values()].filter(
      (t) =>
        (!filter.stylistId || t.stylistId === filter.stylistId) &&
        (!filter.status || t.status === filter.status),
    );
  }
}

describe('Casos de uso de comandas de servicio', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const NOW = new Date('2026-09-28T15:00:00.000Z');
  const STYLIST = 'stylist-1';
  const OTHER_STYLIST = 'stylist-2';
  const CUT = 'service-cut';
  const COLOR = 'service-color';

  let tickets: InMemoryServiceTicketRepository;
  let stylists: InMemoryStylistRepository;
  let services: InMemoryServiceRepository;
  let appointments: InMemoryAppointmentRepository;
  let invoices: jest.Mocked<Pick<InvoiceRepository, 'findByAppointmentId'>>;
  let clients: jest.Mocked<Pick<ClientRepository, 'findByIdOrFail'>>;
  let audit: InMemoryAuditRecorder;
  let clock: FixedClock;

  let register: RegisterServiceTicketUseCase;
  let list: ListServiceTicketsUseCase;
  let cancel: CancelServiceTicketUseCase;
  let assignable: ListAssignableServicesUseCase;

  const buildStylist = (id: string, name: string) =>
    Stylist.create({
      id,
      tenantId: TENANT,
      name: PersonName.create(name, 'Molina'),
      userId: `user-${id}`,
      now: NOW,
      actorId: null,
    });

  const buildService = (id: string, name: string, price: string) =>
    Service.create({
      id,
      tenantId: TENANT,
      code: id.toUpperCase(),
      name,
      durationMinutes: 45,
      price: Money.fromDecimal(price, 'GTQ'),
      now: NOW,
      actorId: null,
    });

  const buildAppointment = (stylistId = STYLIST) =>
    Appointment.schedule({
      id: `appointment-${stylistId}`,
      tenantId: TENANT,
      clientId: 'client-1',
      stylistId,
      startsAt: new Date(NOW.getTime() + 60 * 60_000),
      lines: [
        {
          id: 'line-1',
          serviceId: CUT,
          durationMinutes: 45,
          price: Money.fromDecimal('100.00', 'GTQ'),
          sortOrder: 0,
        },
      ],
      currency: 'GTQ',
      now: NOW,
      actorId: null,
    });

  beforeEach(() => {
    tickets = new InMemoryServiceTicketRepository();
    stylists = new InMemoryStylistRepository().seed(
      buildStylist(STYLIST, 'Sara'),
      buildStylist(OTHER_STYLIST, 'Marta'),
    );
    services = new InMemoryServiceRepository().seed(
      buildService(CUT, 'Corte', '100.00'),
      buildService(COLOR, 'Tinte', '250.00'),
    );
    appointments = new InMemoryAppointmentRepository();
    invoices = { findByAppointmentId: jest.fn().mockResolvedValue(null) };
    clients = {
      findByIdOrFail: jest.fn().mockResolvedValue({ name: PersonName.create('Lucía', 'Pérez') }),
    };
    audit = new InMemoryAuditRecorder();
    clock = new FixedClock(NOW);

    register = new RegisterServiceTicketUseCase(
      tickets,
      stylists,
      services,
      clients as unknown as ClientRepository,
      appointments,
      invoices as unknown as InvoiceRepository,
      new SequentialIdGenerator(),
      clock,
      passthroughUnitOfWork,
      audit,
    );
    list = new ListServiceTicketsUseCase(tickets, services, stylists);
    cancel = new CancelServiceTicketUseCase(tickets, clock, audit);
    assignable = new ListAssignableServicesUseCase(stylists, services);
  });

  const registerFor = (overrides: Record<string, unknown> = {}) =>
    register.execute({
      tenantId: TENANT,
      stylistId: STYLIST,
      clientId: 'client-1',
      serviceIds: [CUT],
      actorId: 'user-stylist-1',
      ...overrides,
    });

  const assignOnly = async (stylistId: string, serviceIds: string[]) => {
    const stylist = await stylists.findByIdOrFail(stylistId);
    stylist.replaceSkills(
      serviceIds.map((serviceId) => ({ serviceId, durationMinutes: null, commissionRate: null })),
      NOW,
      null,
    );
    await stylists.update(stylist);
  };

  describe('registrar', () => {
    it('deja la comanda pendiente con el nombre de la ficha y lo audita', async () => {
      const ticket = await registerFor();

      expect(ticket.status).toBe('PENDING');
      expect(ticket.clientName).toBe('Lucía Pérez');
      expect(audit.entries).toHaveLength(1);
    });

    it('sin servicios asignados, la profesional puede registrar cualquiera del catálogo', async () => {
      await expect(registerFor({ serviceIds: [CUT, COLOR] })).resolves.toBeDefined();
    });

    it('con servicios asignados, rechaza los que la administración no le asignó', async () => {
      await assignOnly(STYLIST, [CUT]);

      await expect(registerFor({ serviceIds: [COLOR] })).rejects.toMatchObject({
        code: 'SERVICE_NOT_ASSIGNED',
      });
    });

    it('rechaza un servicio dado de baja en el catálogo', async () => {
      const color = await services.findByIdOrFail(COLOR);
      color.deactivate(NOW, null);
      await services.update(color);

      await expect(registerFor({ serviceIds: [COLOR] })).rejects.toMatchObject({
        code: 'ITEM_NOT_AVAILABLE',
      });
    });

    it('desde una cita toma la clienta de la cita y la deja completada', async () => {
      await appointments.create(buildAppointment());

      const ticket = await registerFor({
        clientId: null,
        appointmentId: `appointment-${STYLIST}`,
      });
      const appointment = await appointments.findByIdOrFail(`appointment-${STYLIST}`);

      expect(ticket.clientId).toBe('client-1');
      expect(appointment.status).toBe('COMPLETED');
    });

    it('no admite la cita de otra profesional', async () => {
      await appointments.create(buildAppointment(OTHER_STYLIST));

      await expect(
        registerFor({ clientId: null, appointmentId: `appointment-${OTHER_STYLIST}` }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });

    it('no registra dos veces la misma cita', async () => {
      await appointments.create(buildAppointment());
      await registerFor({ clientId: null, appointmentId: `appointment-${STYLIST}` });

      await expect(
        registerFor({ clientId: null, appointmentId: `appointment-${STYLIST}` }),
      ).rejects.toMatchObject({ code: 'APPOINTMENT_ALREADY_REGISTERED' });
    });
  });

  describe('listar', () => {
    it('calcula el total con la misma regla que la factura', async () => {
      await registerFor({ serviceIds: [CUT, COLOR] });

      const page = await list.execute({
        filter: { status: 'PENDING' },
        page: { page: 1, limit: 20 },
        currency: 'GTQ',
        restrictToStylistId: null,
      });

      // 100 + 250: el IVA ya va dentro de cada precio (ADR-0021).
      expect(page.data[0].total.toDecimalString()).toBe('350.00');
      expect(page.data[0].stylistName).toBe('Sara');
    });

    it('con ámbito propio solo devuelve las comandas de la profesional', async () => {
      await registerFor();
      await registerFor({ stylistId: OTHER_STYLIST });

      const page = await list.execute({
        filter: { stylistId: STYLIST },
        page: { page: 1, limit: 20 },
        currency: 'GTQ',
        restrictToStylistId: OTHER_STYLIST,
      });

      expect(page.data.map((view) => view.ticket.stylistId)).toEqual([OTHER_STYLIST]);
    });

    it('marca como no disponible un servicio retirado después de registrar', async () => {
      await registerFor({ serviceIds: [COLOR] });
      const color = await services.findByIdOrFail(COLOR);
      color.deactivate(NOW, null);
      await services.update(color);

      const page = await list.execute({
        filter: {},
        page: { page: 1, limit: 20 },
        currency: 'GTQ',
        restrictToStylistId: null,
      });

      expect(page.data[0].lines[0].available).toBe(false);
    });
  });

  describe('cobrar', () => {
    const fakeSale = (): RegisterSaleResult => ({
      invoice: {
        id: 'invoice-1',
        number: 'F2026-000001',
        total: Money.fromDecimal('112.00', 'GTQ'),
      } as unknown as Invoice,
      payments: [],
    });

    it('factura los servicios a nombre de la profesional y marca la comanda en la transacción', async () => {
      const ticket = await registerFor();
      let received: RegisterSaleInput | undefined;
      const registerSale = {
        execute: jest.fn(async (input: RegisterSaleInput, within?: WithinSaleTransaction) => {
          received = input;
          const sale = fakeSale();
          await within?.(sale);
          return sale;
        }),
      };
      const charge = new ChargeServiceTicketUseCase(
        tickets,
        registerSale as unknown as RegisterSaleUseCase,
        clock,
        audit,
      );

      const result = await charge.execute({
        ticketId: ticket.id,
        tenantId: TENANT,
        currency: 'GTQ',
        payments: [{ method: 'CASH', amount: '112.00' }],
        actorId: 'user-cashier',
      });

      expect(received?.lines).toEqual([
        { kind: 'SERVICE', itemId: CUT, quantity: 1, stylistId: STYLIST },
      ]);
      expect(received?.clientId).toBe('client-1');
      expect(result.ticket.status).toBe('CHARGED');
      expect(result.ticket.invoiceId).toBe('invoice-1');
    });

    it('no factura una comanda que ya no está pendiente', async () => {
      const ticket = await registerFor();
      await cancel.execute({
        ticketId: ticket.id,
        reason: 'Error',
        actorId: 'user-cashier',
        restrictToStylistId: null,
      });
      const registerSale = { execute: jest.fn() };
      const charge = new ChargeServiceTicketUseCase(
        tickets,
        registerSale as unknown as RegisterSaleUseCase,
        clock,
        audit,
      );

      await expect(
        charge.execute({
          ticketId: ticket.id,
          tenantId: TENANT,
          currency: 'GTQ',
          payments: [{ method: 'CARD', amount: '112.00' }],
          actorId: 'user-cashier',
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_TICKET_NOT_PENDING' });
      expect(registerSale.execute).not.toHaveBeenCalled();
    });
  });

  describe('anular', () => {
    it('la profesional no ve ni anula la comanda de otra', async () => {
      const ticket = await registerFor({ stylistId: OTHER_STYLIST });

      await expect(
        cancel.execute({
          ticketId: ticket.id,
          reason: 'Error',
          actorId: 'user-stylist-1',
          restrictToStylistId: STYLIST,
        }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  });

  describe('servicios asignables', () => {
    it('devuelve solo los asignados y activos', async () => {
      await assignOnly(STYLIST, [COLOR]);

      const result = await assignable.execute({ stylistId: STYLIST });

      expect(result.map((service) => service.id)).toEqual([COLOR]);
    });
  });
});
