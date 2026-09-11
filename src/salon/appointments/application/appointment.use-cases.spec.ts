import { ConflictError, EntityNotFoundError } from '@shared/domain/errors';
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
import { Service } from '@salon/catalog/domain/service.entity';
import { Stylist } from '@salon/stylists/domain/stylist.entity';

import {
  ChangeAppointmentStatusUseCase,
  GetAppointmentUseCase,
  GetAvailabilityUseCase,
  GetCalendarUseCase,
  RescheduleAppointmentUseCase,
  ScheduleAppointmentUseCase,
  SearchAppointmentsUseCase,
} from './appointment.use-cases';

/**
 * Casos de uso de la agenda con dobles en memoria.
 *
 * Complementan a la suite de integración: allí se comprueba que el SQL y la restricción
 * `EXCLUDE` funcionan; aquí, la **orquestación** —qué se valida, en qué orden y qué se
 * audita— sin pagar el coste de una base de datos por test.
 */
describe('Casos de uso de agenda', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const MADRID = 'Europe/Madrid';
  /** Jueves 10 de septiembre de 2026, 08:00 UTC = 10:00 en Madrid. */
  const NOW = new Date('2026-09-10T06:00:00.000Z');
  const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 8, 10, hour - 2, minute));

  let appointments: InMemoryAppointmentRepository;
  let stylists: InMemoryStylistRepository;
  let services: InMemoryServiceRepository;
  let audit: InMemoryAuditRecorder;
  let clock: FixedClock;
  let ids: SequentialIdGenerator;

  let schedule: ScheduleAppointmentUseCase;
  let reschedule: RescheduleAppointmentUseCase;
  let changeStatus: ChangeAppointmentStatusUseCase;
  let search: SearchAppointmentsUseCase;
  let getOne: GetAppointmentUseCase;
  let availability: GetAvailabilityUseCase;
  let calendar: GetCalendarUseCase;

  const STYLIST_ID = 'stylist-1';
  const SERVICE_ID = 'service-1';

  const buildStylist = (): Stylist => {
    const stylist = Stylist.create({
      id: STYLIST_ID,
      tenantId: TENANT,
      name: PersonName.create('Sara', 'Molina'),
      userId: 'user-stylist',
      now: NOW,
      actorId: null,
    });
    // Jueves de 9 a 20, hora local.
    stylist.replaceSchedule(
      [{ id: 'b1', dayOfWeek: 4, startMinutes: 9 * 60, endMinutes: 20 * 60 }],
      NOW,
      null,
    );
    return stylist;
  };

  const buildService = (id = SERVICE_ID, minutes = 45, buffer = 10): Service =>
    Service.create({
      id,
      tenantId: TENANT,
      code: `SVC-${id.slice(-1).toUpperCase()}`,
      name: 'Corte',
      durationMinutes: minutes,
      bufferMinutes: buffer,
      price: Money.fromDecimal('25.00', 'EUR'),
      now: NOW,
      actorId: null,
    });

  beforeEach(() => {
    appointments = new InMemoryAppointmentRepository();
    stylists = new InMemoryStylistRepository().seed(buildStylist());
    services = new InMemoryServiceRepository().seed(buildService());
    audit = new InMemoryAuditRecorder();
    clock = new FixedClock(NOW);
    ids = new SequentialIdGenerator();

    const salon = { timeZone: MADRID };

    schedule = new ScheduleAppointmentUseCase(
      appointments,
      stylists,
      services,
      salon,
      ids,
      clock,
      audit,
      passthroughUnitOfWork,
    );
    reschedule = new RescheduleAppointmentUseCase(appointments, stylists, salon, clock, audit);
    changeStatus = new ChangeAppointmentStatusUseCase(appointments, clock, audit);
    search = new SearchAppointmentsUseCase(appointments);
    getOne = new GetAppointmentUseCase(appointments);
    availability = new GetAvailabilityUseCase(appointments, stylists, services, salon, clock);
    calendar = new GetCalendarUseCase(appointments);
  });

  const book = (startsAt = at(12), overrides: Record<string, unknown> = {}) =>
    schedule.execute({
      tenantId: TENANT,
      clientId: 'client-1',
      stylistId: STYLIST_ID,
      startsAt,
      serviceIds: [SERVICE_ID],
      actorId: 'recepcion',
      ...overrides,
    });

  describe('agendar', () => {
    it('suma la duración del servicio y su margen', async () => {
      const appointment = await book();

      expect(appointment.durationMinutes).toBe(55);
      expect(appointment.estimatedTotal.toDecimalString()).toBe('25.00');
    });

    it('congela el precio del catálogo en la línea', async () => {
      const appointment = await book();
      const service = await services.findByIdOrFail(SERVICE_ID);

      service.changePrice(Money.fromDecimal('99.00', 'EUR'), NOW, null);
      await services.update(service);

      // La cita ya reservada conserva su precio.
      expect(appointment.lines[0].price.toDecimalString()).toBe('25.00');
    });

    it('usa la duración propia del profesional cuando la tiene', async () => {
      const stylist = await stylists.findByIdOrFail(STYLIST_ID);
      stylist.replaceSkills(
        [{ serviceId: SERVICE_ID, durationMinutes: 30, commissionRate: null }],
        NOW,
        null,
      );
      await stylists.update(stylist);

      const appointment = await book();

      // 30 propios + 10 de margen del catálogo.
      expect(appointment.durationMinutes).toBe(40);
    });

    it('rechaza sin servicios', async () => {
      await expect(book(at(12), { serviceIds: [] })).rejects.toThrow(/al menos un servicio/);
    });

    it('rechaza un servicio inexistente', async () => {
      await expect(book(at(12), { serviceIds: ['no-existe'] })).rejects.toThrow(
        EntityNotFoundError,
      );
    });

    it('rechaza un servicio retirado', async () => {
      const service = await services.findByIdOrFail(SERVICE_ID);
      service.deactivate(NOW, null);
      await services.update(service);

      await expect(book()).rejects.toThrow(/retirado del catálogo/);
    });

    it('rechaza un profesional que no admite reservas', async () => {
      const stylist = await stylists.findByIdOrFail(STYLIST_ID);
      stylist.changeStatus('ON_LEAVE', NOW, null);
      await stylists.update(stylist);

      await expect(book()).rejects.toThrow(/no admite reservas/);
    });

    it('rechaza un servicio que el profesional no realiza', async () => {
      services.seed(buildService('service-2', 30, 0));
      const stylist = await stylists.findByIdOrFail(STYLIST_ID);
      stylist.replaceSkills(
        [{ serviceId: SERVICE_ID, durationMinutes: null, commissionRate: null }],
        NOW,
        null,
      );
      await stylists.update(stylist);

      await expect(book(at(12), { serviceIds: ['service-2'] })).rejects.toThrow(/no realiza/);
    });

    it('rechaza fuera del horario', async () => {
      await expect(book(at(21))).rejects.toThrow(/fuera de la jornada/);
    });

    it('permite forzar fuera de horario y lo deja en la auditoría', async () => {
      await book(at(21), { force: true });

      const entry = audit.entries.find((e) => e.entityType === 'Appointment');
      expect((entry!.after as Record<string, unknown>).forcedOutsideSchedule).toBe(true);
    });

    it('rechaza el solapamiento con un mensaje del negocio', async () => {
      await book(at(12));

      const error = await book(at(12, 30))
        .then(() => new Error('se esperaba un conflicto de solapamiento'))
        .catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('APPOINTMENT_OVERLAP');
      // El mensaje nombra a la profesional, no la restricción de PostgreSQL.
      expect(error.message).toContain('Sara');
    });

    it('acepta citas consecutivas', async () => {
      await book(at(12));
      await expect(book(at(13))).resolves.toBeDefined();
    });

    it('una cita cancelada deja de bloquear', async () => {
      const first = await book(at(12));
      await changeStatus.execute({ id: first.id, transition: 'cancel', actorId: 'x' });

      await expect(book(at(12))).resolves.toBeDefined();
    });

    it('audita el alta con los datos relevantes', async () => {
      const appointment = await book();

      const entry = audit.entries.find((e) => e.action === 'CREATE');
      expect(entry!.after).toMatchObject({
        stylistId: STYLIST_ID,
        estimatedTotal: '25.00',
      });
      expect(entry!.entityId).toBe(appointment.id);
    });
  });

  describe('reprogramar', () => {
    it('mueve la cita', async () => {
      const appointment = await book(at(12));

      const moved = await reschedule.execute({
        id: appointment.id,
        startsAt: at(16),
        actorId: 'recepcion',
      });

      expect(moved.period.startsAt).toEqual(at(16));
    });

    it('no choca consigo misma', async () => {
      const appointment = await book(at(12));

      await expect(
        reschedule.execute({ id: appointment.id, startsAt: at(12, 5), actorId: 'x' }),
      ).resolves.toBeDefined();
    });

    it('rechaza mover encima de otra cita', async () => {
      await book(at(12));
      const second = await book(at(16));

      await expect(
        reschedule.execute({ id: second.id, startsAt: at(12, 30), actorId: 'x' }),
      ).rejects.toThrow(ConflictError);
    });

    it('rechaza mover fuera del horario', async () => {
      const appointment = await book(at(12));

      await expect(
        reschedule.execute({ id: appointment.id, startsAt: at(22), actorId: 'x' }),
      ).rejects.toThrow(/fuera de la jornada/);
    });

    it('permite forzar', async () => {
      const appointment = await book(at(12));

      await expect(
        reschedule.execute({ id: appointment.id, startsAt: at(22), force: true, actorId: 'x' }),
      ).resolves.toBeDefined();
    });

    it('reasigna a otro profesional', async () => {
      const other = Stylist.create({
        id: 'stylist-2',
        tenantId: TENANT,
        name: PersonName.create('Marta', 'Delgado'),
        now: NOW,
        actorId: null,
      });
      other.replaceSchedule(
        [{ id: 'b2', dayOfWeek: 4, startMinutes: 9 * 60, endMinutes: 20 * 60 }],
        NOW,
        null,
      );
      stylists.seed(other);

      const appointment = await book(at(12));
      const moved = await reschedule.execute({
        id: appointment.id,
        stylistId: 'stylist-2',
        actorId: 'x',
      });

      expect(moved.stylistId).toBe('stylist-2');
    });

    it('rechaza reasignar a alguien que no admite reservas', async () => {
      const other = Stylist.create({
        id: 'stylist-3',
        tenantId: TENANT,
        name: PersonName.create('Ana', 'Ruiz'),
        now: NOW,
        actorId: null,
      });
      other.changeStatus('INACTIVE', NOW, null);
      stylists.seed(other);

      const appointment = await book(at(12));

      await expect(
        reschedule.execute({ id: appointment.id, stylistId: 'stylist-3', actorId: 'x' }),
      ).rejects.toThrow(/no admite reservas/);
    });
  });

  describe('cambios de estado', () => {
    it('recorre el ciclo y audita cada paso', async () => {
      const appointment = await book(at(12));
      audit.clear();

      await changeStatus.execute({ id: appointment.id, transition: 'confirm', actorId: 'x' });
      await changeStatus.execute({ id: appointment.id, transition: 'start', actorId: 'x' });
      const done = await changeStatus.execute({
        id: appointment.id,
        transition: 'complete',
        actorId: 'x',
      });

      expect(done.status).toBe('COMPLETED');
      expect(audit.entries).toHaveLength(3);
      expect(audit.entries[0].before).toMatchObject({ status: 'SCHEDULED' });
    });

    it('guarda el motivo de la cancelación', async () => {
      const appointment = await book(at(12));

      const cancelled = await changeStatus.execute({
        id: appointment.id,
        transition: 'cancel',
        reason: 'La clienta ha avisado',
        actorId: 'x',
      });

      expect(cancelled.cancellationReason).toBe('La clienta ha avisado');
    });

    it('marca no presentada pasada la hora', async () => {
      const appointment = await book(at(12));
      clock.setTo(at(13));

      const result = await changeStatus.execute({
        id: appointment.id,
        transition: 'no-show',
        actorId: 'x',
      });

      expect(result.status).toBe('NO_SHOW');
    });

    it('respeta el ámbito propio', async () => {
      const appointment = await book(at(12));

      await expect(
        changeStatus.execute({
          id: appointment.id,
          transition: 'confirm',
          actorId: 'x',
          restrictToStylistId: 'otro-stylist',
        }),
      ).rejects.toThrow(/otro profesional/);

      await expect(
        changeStatus.execute({
          id: appointment.id,
          transition: 'confirm',
          actorId: 'x',
          restrictToStylistId: STYLIST_ID,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('consulta', () => {
    it('el ámbito propio se impone al filtro del cliente', async () => {
      await book(at(12));

      // El cliente pide la agenda de otra persona; el servidor lo ignora.
      const page = await search.execute({
        filter: { stylistId: 'otro-stylist' },
        page: { page: 1, limit: 20 },
        restrictToStylistId: STYLIST_ID,
      });

      expect(page.meta.total).toBe(1);
      expect(page.data[0].stylistId).toBe(STYLIST_ID);
    });

    it('sin ámbito propio respeta el filtro recibido', async () => {
      await book(at(12));

      const page = await search.execute({
        filter: { stylistId: 'otro-stylist' },
        page: { page: 1, limit: 20 },
      });

      expect(page.meta.total).toBe(0);
    });

    it('consultar una cita ajena con ámbito propio falla', async () => {
      const appointment = await book(at(12));

      await expect(
        getOne.execute({ id: appointment.id, restrictToStylistId: 'otro' }),
      ).rejects.toThrow(/otro profesional/);
    });

    it('el calendario limita el rango a 31 días', async () => {
      await expect(
        calendar.execute({ from: at(9), to: new Date(at(9).getTime() + 40 * 86_400_000) }),
      ).rejects.toThrow(/31 días/);
    });

    it('el calendario aplica el ámbito propio', async () => {
      await book(at(12));

      const own = await calendar.execute({
        from: at(0),
        to: at(23),
        restrictToStylistId: 'otro-stylist',
      });

      expect(own).toHaveLength(0);
    });
  });

  describe('disponibilidad', () => {
    it('ofrece huecos del día', async () => {
      const slots = await availability.execute({
        stylistId: STYLIST_ID,
        date: '2026-09-10',
        serviceIds: [SERVICE_ID],
        granularityMinutes: 60,
      });

      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0].durationMinutes).toBe(55);
    });

    it('descuenta las citas existentes', async () => {
      const before = await availability.execute({
        stylistId: STYLIST_ID,
        date: '2026-09-10',
        serviceIds: [SERVICE_ID],
        granularityMinutes: 60,
      });

      await book(at(12));

      const after = await availability.execute({
        stylistId: STYLIST_ID,
        date: '2026-09-10',
        serviceIds: [SERVICE_ID],
        granularityMinutes: 60,
      });

      expect(after.length).toBeLessThan(before.length);
    });

    it('un profesional que no admite reservas no tiene huecos', async () => {
      const stylist = await stylists.findByIdOrFail(STYLIST_ID);
      stylist.changeStatus('INACTIVE', NOW, null);
      await stylists.update(stylist);

      await expect(
        availability.execute({
          stylistId: STYLIST_ID,
          date: '2026-09-10',
          serviceIds: [SERVICE_ID],
        }),
      ).resolves.toEqual([]);
    });

    it('un día sin horario no tiene huecos', async () => {
      // Viernes: el horario solo cubre los jueves.
      await expect(
        availability.execute({
          stylistId: STYLIST_ID,
          date: '2026-09-11',
          serviceIds: [SERVICE_ID],
        }),
      ).resolves.toEqual([]);
    });

    it('rechaza un servicio inexistente', async () => {
      await expect(
        availability.execute({
          stylistId: STYLIST_ID,
          date: '2026-09-10',
          serviceIds: [SERVICE_ID, 'no-existe'],
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('respeta la antelación mínima', async () => {
      const sinAntelacion = await availability.execute({
        stylistId: STYLIST_ID,
        date: '2026-09-10',
        serviceIds: [SERVICE_ID],
        granularityMinutes: 60,
      });

      const conAntelacion = await availability.execute({
        stylistId: STYLIST_ID,
        date: '2026-09-10',
        serviceIds: [SERVICE_ID],
        granularityMinutes: 60,
        minimumNoticeMinutes: 240,
      });

      expect(conAntelacion.length).toBeLessThan(sinAntelacion.length);
    });
  });
});
