import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import { Money } from '@shared/domain/value-objects/money.vo';
import { PersonName } from '@shared/domain/value-objects/contact.vo';
import { InMemoryAuditRecorder } from '@test/doubles/auth.doubles';
import {
  FakeReminderSender,
  InMemoryChangeRequestRepository,
  InMemoryReminderLog,
  RecordingAgendaEvents,
} from '@test/doubles/agenda.doubles';
import {
  InMemoryAppointmentRepository,
  InMemoryServiceRepository,
  InMemoryStylistRepository,
  passthroughUnitOfWork,
} from '@test/doubles/salon.doubles';
import { Service } from '@salon/catalog/domain/service.entity';
import { Stylist } from '@salon/stylists/domain/stylist.entity';

import {
  BlockStylistTimeUseCase,
  GetAvailabilityUseCase,
  RescheduleAppointmentUseCase,
  ScheduleAppointmentUseCase,
} from './appointment.use-cases';
import {
  ApproveChangeRequestUseCase,
  RejectChangeRequestUseCase,
  RequestAppointmentChangeUseCase,
  WithdrawChangeRequestUseCase,
} from './change-request.use-cases';
import { PrepareManualReminderUseCase, SendDueRemindersUseCase } from './reminder.use-cases';
import { LoggingReminderSender } from '../infrastructure/reminders/reminder-senders';

/**
 * Mejoras de la agenda: huecos con cualquier profesional, cambios de hora que aprueba la
 * encargada, bloqueos y recordatorios. Con dobles en memoria: aquí se prueba la
 * orquestación; la suite de integración prueba el SQL.
 */
describe('Agenda: equipo, cambios pedidos, bloqueos y recordatorios', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  const GUATEMALA = 'America/Guatemala';
  /** Jueves 8 de octubre de 2026, 8:00 en Guatemala. */
  const NOW = new Date('2026-10-08T14:00:00.000Z');
  /** Hora local de Guatemala del viernes 9. */
  const fri = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 9, hour + 6, minute));

  let appointments: InMemoryAppointmentRepository;
  let stylists: InMemoryStylistRepository;
  let services: InMemoryServiceRepository;
  let audit: InMemoryAuditRecorder;
  let events: RecordingAgendaEvents;
  let requests: InMemoryChangeRequestRepository;
  let clock: FixedClock;
  let ids: SequentialIdGenerator;
  const salon = { timeZone: GUATEMALA };

  let schedule: ScheduleAppointmentUseCase;
  let reschedule: RescheduleAppointmentUseCase;
  let availability: GetAvailabilityUseCase;

  const CUT = 'svc-cut';
  const BALAYAGE = 'svc-balayage';

  const stylist = (id: string, name: string, userId: string, skills: string[] = []) => {
    const created = Stylist.create({
      id,
      tenantId: TENANT,
      name: PersonName.create(name, 'Demo'),
      userId,
      now: NOW,
      actorId: null,
    });
    // De lunes a sábado, de 9 a 18.
    created.replaceSchedule(
      [1, 2, 3, 4, 5, 6].map((day) => ({
        id: `${id}-${day}`,
        dayOfWeek: day,
        startMinutes: 9 * 60,
        endMinutes: 18 * 60,
      })),
      NOW,
      null,
    );
    if (skills.length) {
      created.replaceSkills(
        skills.map((serviceId) => ({ serviceId, durationMinutes: null, commissionRate: null })),
        NOW,
        null,
      );
    }
    return created;
  };

  const service = (id: string, minutes: number) =>
    Service.create({
      id,
      tenantId: TENANT,
      code: id.toUpperCase(),
      name: id,
      durationMinutes: minutes,
      bufferMinutes: 0,
      price: Money.fromDecimal('100.00', 'GTQ'),
      now: NOW,
      actorId: null,
    });

  beforeEach(() => {
    appointments = new InMemoryAppointmentRepository();
    stylists = new InMemoryStylistRepository()
      .seed(stylist('sara', 'Sara', 'user-sara'))
      // Andrea no hace balayage.
      .seed(stylist('andrea', 'Andrea', 'user-andrea', [CUT]));
    services = new InMemoryServiceRepository().seed(service(CUT, 60)).seed(service(BALAYAGE, 120));
    audit = new InMemoryAuditRecorder();
    events = new RecordingAgendaEvents();
    requests = new InMemoryChangeRequestRepository();
    clock = new FixedClock(NOW);
    ids = new SequentialIdGenerator();

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
    availability = new GetAvailabilityUseCase(appointments, stylists, services, salon, clock);
  });

  const book = (stylistId: string, startsAt: Date, serviceIds = [CUT]) =>
    schedule.execute({
      tenantId: TENANT,
      clientId: 'client-1',
      stylistId,
      startsAt,
      serviceIds,
      actorId: 'recepcion',
    });

  describe('huecos con cualquier profesional', () => {
    it('reúne los de todo el equipo y dice con quién es cada uno', async () => {
      await book('sara', fri(9));
      const slots = await availability.execute({ date: '2026-10-09', serviceIds: [CUT] });

      const at9 = slots.filter((slot) => slot.startsAt === fri(9).toISOString());
      expect(at9.map((slot) => slot.stylistId)).toEqual(['andrea']);
      expect(new Set(slots.map((slot) => slot.stylistId))).toEqual(new Set(['sara', 'andrea']));
    });

    it('no ofrece a quien no hace el servicio', async () => {
      const slots = await availability.execute({ date: '2026-10-09', serviceIds: [BALAYAGE] });
      expect(new Set(slots.map((slot) => slot.stylistId))).toEqual(new Set(['sara']));
    });

    it('pedir a una profesional concreta un servicio que no hace es un error claro', async () => {
      await expect(
        availability.execute({ stylistId: 'andrea', date: '2026-10-09', serviceIds: [BALAYAGE] }),
      ).rejects.toMatchObject({ code: 'STYLIST_CANNOT_PERFORM_SERVICE' });
    });

    it('con ámbito propio solo ve su agenda, aunque pida la de otra', async () => {
      const slots = await availability.execute({
        stylistId: 'andrea',
        date: '2026-10-09',
        serviceIds: [CUT],
        restrictToStylistId: 'sara',
      });
      expect(new Set(slots.map((slot) => slot.stylistId))).toEqual(new Set(['sara']));
    });

    it('al mover una cita, su propio hueco cuenta como libre', async () => {
      const booked = await book('sara', fri(9));
      const without = await availability.execute({
        stylistId: 'sara',
        date: '2026-10-09',
        serviceIds: [CUT],
      });
      const moving = await availability.execute({
        stylistId: 'sara',
        date: '2026-10-09',
        serviceIds: [CUT],
        excludeAppointmentId: booked.id,
      });
      expect(without.some((slot) => slot.startsAt === fri(9, 30).toISOString())).toBe(false);
      expect(moving.some((slot) => slot.startsAt === fri(9, 30).toISOString())).toBe(true);
    });
  });

  it('pasar una cita a quien no hace el servicio no está permitido', async () => {
    const booked = await book('sara', fri(10), [BALAYAGE]);
    await expect(
      reschedule.execute({ id: booked.id, stylistId: 'andrea', actorId: 'recepcion' }),
    ).rejects.toMatchObject({ code: 'STYLIST_CANNOT_PERFORM_SERVICE' });
  });

  describe('cambios de hora que pide la profesional', () => {
    let requestChange: RequestAppointmentChangeUseCase;
    let approve: ApproveChangeRequestUseCase;
    let reject: RejectChangeRequestUseCase;
    let withdraw: WithdrawChangeRequestUseCase;

    beforeEach(() => {
      requestChange = new RequestAppointmentChangeUseCase(
        appointments,
        requests,
        stylists,
        salon,
        ids,
        clock,
        audit,
        events,
      );
      approve = new ApproveChangeRequestUseCase(
        requests,
        reschedule,
        clock,
        audit,
        passthroughUnitOfWork,
        events,
        appointments,
      );
      reject = new RejectChangeRequestUseCase(requests, clock, audit, events);
      withdraw = new WithdrawChangeRequestUseCase(requests, clock, audit, events);
    });

    const ask = (appointmentId: string, startsAt: Date, stylistId = 'sara') =>
      requestChange.execute({
        appointmentId,
        proposedStartsAt: startsAt,
        actorId: `user-${stylistId}`,
        stylistId,
      });

    it('pedir no mueve la cita; aprobar sí, y avisa a quien la pidió', async () => {
      const booked = await book('sara', fri(10));
      const request = await ask(booked.id, fri(12));

      expect((await appointments.findByIdOrFail(booked.id)).period.startsAt).toEqual(fri(10));
      expect(events.published.at(-1)).toMatchObject({ kind: 'change-request', status: 'PENDING' });

      const approved = await approve.execute({ id: request.id, actorId: 'encargada' });

      expect(approved.status).toBe('APPROVED');
      expect((await appointments.findByIdOrFail(booked.id)).period.startsAt).toEqual(fri(12));
      expect(events.published.at(-1)).toMatchObject({ status: 'APPROVED', stylistIds: ['sara'] });
    });

    it('rechazar deja la cita donde estaba', async () => {
      const booked = await book('sara', fri(10));
      const request = await ask(booked.id, fri(12));

      await reject.execute({ id: request.id, actorId: 'encargada', note: 'ese hueco no' });

      expect((await appointments.findByIdOrFail(booked.id)).period.startsAt).toEqual(fri(10));
      expect((await requests.findByIdOrFail(request.id)).decisionNote).toBe('ese hueco no');
    });

    it('una profesional no puede pedir cambios sobre citas de otra', async () => {
      const booked = await book('sara', fri(10));
      await expect(ask(booked.id, fri(12), 'andrea')).rejects.toMatchObject({
        code: 'FORBIDDEN_ACTION',
      });
    });

    it('la hora propuesta tiene que caber: ni fuera de jornada ni encima de otra cita', async () => {
      const booked = await book('sara', fri(10));
      await book('sara', fri(14));

      await expect(ask(booked.id, fri(19))).rejects.toMatchObject({
        code: 'OUTSIDE_WORKING_HOURS',
      });
      await expect(ask(booked.id, fri(14))).rejects.toMatchObject({ code: 'APPOINTMENT_OVERLAP' });
    });

    it('como mucho una pendiente por cita; retirarla permite pedir otra', async () => {
      const booked = await book('sara', fri(10));
      const first = await ask(booked.id, fri(12));

      await expect(ask(booked.id, fri(13))).rejects.toMatchObject({
        code: 'CHANGE_REQUEST_ALREADY_PENDING',
      });

      await withdraw.execute({ id: first.id, actorId: 'user-sara', stylistId: 'sara' });
      await expect(ask(booked.id, fri(13))).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('si recepción movió la cita mientras esperaba, aprobar no pisa ese cambio', async () => {
      const booked = await book('sara', fri(10));
      const request = await ask(booked.id, fri(12));
      await reschedule.execute({ id: booked.id, startsAt: fri(11), actorId: 'recepcion' });

      await expect(approve.execute({ id: request.id, actorId: 'encargada' })).rejects.toMatchObject(
        { code: 'CHANGE_REQUEST_OUTDATED' },
      );
      expect((await appointments.findByIdOrFail(booked.id)).period.startsAt).toEqual(fri(11));
    });

    it('si el hueco se ocupó mientras esperaba, aprobar falla y la petición sigue pendiente', async () => {
      const booked = await book('sara', fri(10));
      const request = await ask(booked.id, fri(12));
      await book('sara', fri(12));

      await expect(approve.execute({ id: request.id, actorId: 'encargada' })).rejects.toMatchObject(
        { code: 'APPOINTMENT_OVERLAP' },
      );
      expect((await requests.findByIdOrFail(request.id)).status).toBe('PENDING');
    });
  });

  describe('bloqueos de agenda', () => {
    let block: BlockStylistTimeUseCase;

    beforeEach(() => {
      block = new BlockStylistTimeUseCase(stylists, appointments, ids, clock, audit, events);
    });

    it('no se puede bloquear encima de una cita', async () => {
      await book('sara', fri(13));
      await expect(
        block.execute({ stylistId: 'sara', startsAt: fri(13), endsAt: fri(14), actorId: 'x' }),
      ).rejects.toMatchObject({ code: 'BLOCK_OVERLAPS_APPOINTMENTS' });
    });

    it('un tramo bloqueado deja de ofrecerse como hueco', async () => {
      await block.execute({
        stylistId: 'sara',
        startsAt: fri(13),
        endsAt: fri(14),
        reason: 'Comida',
        actorId: 'encargada',
      });
      const slots = await availability.execute({
        stylistId: 'sara',
        date: '2026-10-09',
        serviceIds: [CUT],
      });
      expect(slots.some((slot) => slot.startsAt === fri(13).toISOString())).toBe(false);
      expect(slots.some((slot) => slot.startsAt === fri(14).toISOString())).toBe(true);
      expect(events.published.at(-1)).toMatchObject({ kind: 'block', stylistIds: ['sara'] });
    });
  });

  describe('recordatorios', () => {
    // 26 horas: desde el jueves a las 8:00 alcanza a las citas del viernes a primera hora.
    const settings = {
      enabled: true,
      leadHours: 26,
      minimumLeadMinutes: 120,
      publicWebUrl: 'http://localhost:3001/',
      defaultCountryCode: '502',
      timeZone: GUATEMALA,
    };
    let log: InMemoryReminderLog;
    let sender: FakeReminderSender;
    let sendDue: SendDueRemindersUseCase;

    beforeEach(() => {
      log = new InMemoryReminderLog(appointments);
      sender = new FakeReminderSender();
      sendDue = new SendDueRemindersUseCase(log, sender, settings, ids, clock, events);
    });

    it('envía a las citas dentro de la antelación, con enlace, y no repite', async () => {
      const due = await book('sara', fri(9));
      await book('sara', new Date(Date.UTC(2026, 9, 12, 16))); // el lunes: aún no toca

      await expect(sendDue.execute()).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
      expect(sender.sent[0].to).toBe('+50255551234');
      expect(sender.sent[0].body).toMatch(/http:\/\/localhost:3001\/cita\/[\w-]{20,}/);
      expect((await appointments.findByIdOrFail(due.id)).reminderSentAt).toEqual(NOW);

      await expect(sendDue.execute()).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    });

    it('sin proveedor no envía ni marca nada como recordado', async () => {
      // Con el canal `log` no sale ningún mensaje: anotar la cita como recordada haría creer
      // a recepción que la clienta fue avisada.
      const due = await book('sara', fri(9));
      const withoutProvider = new SendDueRemindersUseCase(
        log,
        new LoggingReminderSender(),
        settings,
        ids,
        clock,
        events,
      );

      await expect(withoutProvider.execute()).rejects.toThrow(/proveedor/);
      expect((await appointments.findByIdOrFail(due.id)).reminderSentAt).toBeFalsy();
      expect(log.attempts).toHaveLength(0);
    });

    it('sin teléfono se descarta una vez y no se reintenta', async () => {
      const due = await book('sara', fri(9));
      log.contexts.set(due.id, {
        tenantId: TENANT,
        salonName: 'Salón',
        clientFirstName: 'Marisol',
        clientPhone: null,
        stylistName: 'Sara',
        serviceNames: [],
      });

      await expect(sendDue.execute()).resolves.toEqual({ sent: 0, failed: 0, skipped: 1 });
      await expect(sendDue.execute()).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    });

    it('si el proveedor falla se anota y se reintenta hasta tres veces', async () => {
      await book('sara', fri(9));
      sender.failWith = 'Twilio caído';

      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(sendDue.execute()).resolves.toEqual({ sent: 0, failed: 1, skipped: 0 });
      }
      await expect(sendDue.execute()).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
      expect(log.attempts.every((attempt) => attempt.error === 'Twilio caído')).toBe(true);
    });

    it('recepción prepara el WhatsApp manual y queda anotado como enviado', async () => {
      const due = await book('sara', fri(9));
      const manual = new PrepareManualReminderUseCase(
        log,
        appointments,
        settings,
        ids,
        clock,
        events,
      );

      const prepared = await manual.execute({ appointmentId: due.id, actorId: 'recepcion' });

      expect(prepared.whatsappUrl).toMatch(/^https:\/\/wa\.me\/50255551234\?text=Hola%20Rosa/);
      expect(log.attempts.at(-1)).toMatchObject({ channel: 'MANUAL', status: 'SENT' });
      await expect(sendDue.execute()).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    });
  });
});
