import {
  BusinessRuleViolationError,
  ConflictError,
  EntityNotFoundError,
  InvalidStateTransitionError,
} from '@shared/domain/errors';
import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import { Money } from '@shared/domain/value-objects/money.vo';
import { PersonName } from '@shared/domain/value-objects/contact.vo';
import { InMemoryAuditRecorder } from '@test/doubles/auth.doubles';
import { RecordingAgendaEvents } from '@test/doubles/agenda.doubles';
import {
  InMemoryQueueDisplayLinks,
  InMemoryQueueTurnRepository,
} from '@test/doubles/queue.doubles';
import {
  InMemoryServiceRepository,
  InMemoryStylistRepository,
  passthroughUnitOfWork,
} from '@test/doubles/salon.doubles';
import { Service } from '@salon/catalog/domain/service.entity';
import type { Client } from '@salon/clients/domain/client.entity';
import type { ClientRepository } from '@salon/clients/domain/client.repository';
import type { RegisterServiceTicketUseCase } from '@salon/service-tickets/application/service-ticket.use-cases';
import { ServiceTicket } from '@salon/service-tickets/domain/service-ticket.entity';
import { Stylist } from '@salon/stylists/domain/stylist.entity';

import type { QueueTurnFact } from '../domain/queue-stats';
import { QueueTurn } from '../domain/queue-turn.entity';
import {
  displayTokenDigest,
  GetQueueBoardUseCase,
  GetQueueDisplayUseCase,
  IssueQueueDisplayLinkUseCase,
} from './queue-board.use-cases';
import { GetQueueStatsUseCase } from './queue-stats.use-cases';
import {
  CallNextUseCase,
  CallTurnUseCase,
  ChangeQueueTurnUseCase,
  FinishQueueTurnUseCase,
  RegisterWalkInUseCase,
} from './queue.use-cases';

describe('Casos de uso de la fila de espera', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';
  /** 09:00 en Guatemala del lunes 12 de octubre. */
  const NOW = new Date('2026-10-12T15:00:00.000Z');
  const TODAY = '2026-10-12';
  const SARA = 'stylist-sara';
  const VALERIA = 'stylist-valeria';
  const CUT = 'service-cut';
  const COLOR = 'service-color';
  const ANA = 'client-ana';

  let turns: InMemoryQueueTurnRepository;
  let stylists: InMemoryStylistRepository;
  let services: InMemoryServiceRepository;
  let clients: jest.Mocked<Pick<ClientRepository, 'findByIdOrFail'>>;
  let registerTicket: jest.Mocked<Pick<RegisterServiceTicketUseCase, 'execute'>>;
  let audit: InMemoryAuditRecorder;
  let events: RecordingAgendaEvents;
  let clock: FixedClock;

  let register: RegisterWalkInUseCase;
  let callNext: CallNextUseCase;
  let callTurn: CallTurnUseCase;
  let change: ChangeQueueTurnUseCase;
  let finish: FinishQueueTurnUseCase;
  let board: GetQueueBoardUseCase;
  let display: GetQueueDisplayUseCase;

  const settings = { timeZone: 'America/Guatemala', currency: 'GTQ' };

  const buildStylist = (id: string, name: string) =>
    Stylist.create({
      id,
      tenantId: TENANT,
      name: PersonName.create(name, 'Molina'),
      userId: `user-${id}`,
      now: NOW,
      actorId: null,
    });

  const buildService = (id: string, name: string) =>
    Service.create({
      id,
      tenantId: TENANT,
      code: id.toUpperCase(),
      name,
      durationMinutes: 45,
      price: Money.fromDecimal('100.00', 'GTQ'),
      now: NOW,
      actorId: null,
    });

  /** Valeria solo corta. Sara hace de todo (sin habilidades asignadas). */
  const onlyCuts = async (stylistId: string) => {
    const stylist = await stylists.findByIdOrFail(stylistId);
    stylist.replaceSkills(
      [{ serviceId: CUT, durationMinutes: null, commissionRate: null }],
      NOW,
      null,
    );
    await stylists.update(stylist);
  };

  const walkIn = (input: Partial<Parameters<RegisterWalkInUseCase['execute']>[0]> = {}) =>
    register.execute({
      tenantId: TENANT,
      clientName: 'Clienta de paso',
      serviceIds: [CUT],
      actorId: 'reception',
      ...input,
    });

  beforeEach(async () => {
    turns = new InMemoryQueueTurnRepository();
    stylists = new InMemoryStylistRepository();
    services = new InMemoryServiceRepository();
    audit = new InMemoryAuditRecorder();
    events = new RecordingAgendaEvents();
    clock = new FixedClock(NOW);
    clients = {
      findByIdOrFail: jest.fn(
        async (_id: string) => ({ name: PersonName.create('Ana', 'García') }) as Client,
      ),
    };
    registerTicket = {
      execute: jest.fn(async (input) =>
        ServiceTicket.register({
          id: `ticket-${registerTicket.execute.mock.calls.length}`,
          tenantId: input.tenantId,
          stylistId: input.stylistId,
          clientId: input.clientId,
          clientName: input.clientName ?? '',
          serviceIds: input.serviceIds,
          notes: input.notes,
          now: clock.now(),
          actorId: input.actorId,
        }),
      ),
    };

    await stylists.create(buildStylist(SARA, 'Sara'));
    await stylists.create(buildStylist(VALERIA, 'Valeria'));
    await services.create(buildService(CUT, 'Corte'));
    await services.create(buildService(COLOR, 'Tinte'));

    const ids = new SequentialIdGenerator();
    register = new RegisterWalkInUseCase(
      turns,
      services,
      stylists,
      clients as unknown as ClientRepository,
      settings,
      ids,
      clock,
      passthroughUnitOfWork,
      audit,
      events,
    );
    callNext = new CallNextUseCase(turns, stylists, settings, clock, audit, events);
    callTurn = new CallTurnUseCase(turns, stylists, clock, audit, events);
    change = new ChangeQueueTurnUseCase(turns, clock, audit, events);
    finish = new FinishQueueTurnUseCase(
      turns,
      registerTicket as unknown as RegisterServiceTicketUseCase,
      clock,
      passthroughUnitOfWork,
      audit,
      events,
    );
    board = new GetQueueBoardUseCase(turns, services, stylists, settings, clock);
    display = new GetQueueDisplayUseCase(turns, stylists, settings, clock);
  });

  // ===========================================================================

  describe('anotar en la fila', () => {
    it('da números correlativos del día y avisa por el canal en vivo', async () => {
      const first = await walkIn();
      clock.advanceBy(60_000);
      const second = await walkIn({ clientName: 'Otra clienta' });

      expect([first.number, second.number]).toEqual([1, 2]);
      expect(first.businessDate).toBe(TODAY);
      expect(audit.actionsFor('QueueTurn')).toEqual(['CREATE', 'CREATE']);
      expect(events.published.map((event) => [event.kind, event.status])).toEqual([
        ['queue', 'WAITING'],
        ['queue', 'WAITING'],
      ]);
    });

    it('al día siguiente la fila empieza otra vez en el 1', async () => {
      await walkIn();
      clock.advanceBy(24 * 60 * 60_000);

      const tomorrow = await walkIn();

      expect(tomorrow.number).toBe(1);
      expect(tomorrow.businessDate).toBe('2026-10-13');
    });

    it('con ficha toma el nombre de la ficha', async () => {
      const turn = await walkIn({ clientId: ANA, clientName: 'ignorado' });
      expect(turn.clientName).toBe('Ana García');
      expect(turn.clientId).toBe(ANA);
    });

    it('no anota dos veces a la misma clienta mientras espera o la atienden', async () => {
      const first = await walkIn({ clientId: ANA });

      await expect(walkIn({ clientId: ANA })).rejects.toMatchObject({
        code: 'QUEUE_CLIENT_ALREADY_WAITING',
      });

      await callNext.execute({ stylistId: SARA, actorId: 'sara' });
      await expect(walkIn({ clientId: ANA })).rejects.toBeInstanceOf(ConflictError);

      // Atendida, puede volver a la fila (otra visita el mismo día).
      await finish.execute({
        tenantId: TENANT,
        turnId: first.id,
        serviceIds: [CUT],
        actorId: 'sara',
        restrictToStylistId: SARA,
      });
      await expect(walkIn({ clientId: ANA })).resolves.toMatchObject({ number: 2 });
    });

    it('rechaza servicios que no existen o están de baja', async () => {
      await expect(walkIn({ serviceIds: ['missing'] })).rejects.toBeInstanceOf(EntityNotFoundError);

      const color = await services.findByIdOrFail(COLOR);
      color.deactivate(NOW, null);
      await services.update(color);
      await expect(walkIn({ serviceIds: [COLOR] })).rejects.toMatchObject({
        code: 'ITEM_NOT_AVAILABLE',
      });
    });

    it('la profesional pedida tiene que estar activa y saber hacerlo', async () => {
      await onlyCuts(VALERIA);
      await expect(
        walkIn({ serviceIds: [COLOR], preferredStylistId: VALERIA }),
      ).rejects.toMatchObject({ code: 'SERVICE_NOT_ASSIGNED' });

      const sara = await stylists.findByIdOrFail(SARA);
      sara.changeStatus('INACTIVE', NOW, null);
      await stylists.update(sara);
      await expect(walkIn({ preferredStylistId: SARA })).rejects.toMatchObject({
        code: 'STYLIST_NOT_ACTIVE',
      });
    });

    it('sin servicios anotados, cualquiera puede atenderla', async () => {
      const turn = await walkIn({ serviceIds: undefined, preferredStylistId: VALERIA });
      expect(turn.serviceIds).toEqual([]);
      expect(events.published[0].stylistIds).toEqual([VALERIA]);
    });
  });

  // ===========================================================================

  describe('llamar siguiente', () => {
    it('se lleva a la primera que llegó y que ella puede atender', async () => {
      await onlyCuts(VALERIA);
      await walkIn({ clientName: 'Pide tinte', serviceIds: [COLOR] });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Pide a Sara', preferredStylistId: SARA });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Corte', serviceIds: [CUT] });

      const called = await callNext.execute({ stylistId: VALERIA, actorId: 'valeria' });

      expect(called).toMatchObject({
        clientName: 'Corte',
        status: 'CALLED',
        stylistId: VALERIA,
        callCount: 1,
      });
      expect(audit.entries.at(-1)!.after).toMatchObject({ status: 'CALLED' });
      expect(events.published.at(-1)).toMatchObject({ kind: 'queue', status: 'CALLED' });

      // Sara, que hace de todo, se lleva a la primera de la fila.
      const forSara = await callNext.execute({ stylistId: SARA, actorId: 'sara' });
      expect(forSara!.clientName).toBe('Pide tinte');
    });

    it('devuelve null si no queda nadie para ella', async () => {
      await walkIn({ preferredStylistId: SARA });
      await expect(
        callNext.execute({ stylistId: VALERIA, actorId: 'valeria' }),
      ).resolves.toBeNull();
    });

    it('no llama lo que quedó en espera ayer', async () => {
      const yesterday = await walkIn();
      clock.advanceBy(24 * 60 * 60_000);

      await expect(callNext.execute({ stylistId: SARA, actorId: 'sara' })).resolves.toBeNull();
      expect((await turns.findByIdOrFail(yesterday.id)).status).toBe('WAITING');
    });

    it('si otra profesional se la lleva en el mismo instante, pasa a la siguiente', async () => {
      const first = await walkIn({ clientName: 'Primera' });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Segunda' });
      turns.stolen.add(first.id);

      const called = await callNext.execute({ stylistId: SARA, actorId: 'sara' });

      expect(called!.clientName).toBe('Segunda');
    });

    it('no deja tener dos clientas a la vez', async () => {
      await walkIn();
      await walkIn({ clientName: 'Otra' });
      await callNext.execute({ stylistId: SARA, actorId: 'sara' });

      await expect(callNext.execute({ stylistId: SARA, actorId: 'sara' })).rejects.toMatchObject({
        code: 'QUEUE_STYLIST_BUSY',
      });
    });

    it('una profesional inactiva no atiende la fila', async () => {
      const sara = await stylists.findByIdOrFail(SARA);
      sara.changeStatus('ON_LEAVE', NOW, null);
      await stylists.update(sara);

      await expect(callNext.execute({ stylistId: SARA, actorId: 'sara' })).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
    });

    it('un fallo que no es de concurrencia no se disimula', async () => {
      await walkIn();
      jest.spyOn(turns, 'update').mockRejectedValueOnce(new Error('base caída'));

      await expect(callNext.execute({ stylistId: SARA, actorId: 'sara' })).rejects.toThrow(
        'base caída',
      );
    });
  });

  describe('llamar un turno concreto (recepción)', () => {
    it('se salta la preferencia de la clienta', async () => {
      const turn = await walkIn({ preferredStylistId: SARA });

      const called = await callTurn.execute({
        turnId: turn.id,
        stylistId: VALERIA,
        actorId: 'reception',
      });

      expect(called).toMatchObject({ status: 'CALLED', stylistId: VALERIA });
      expect(events.published.at(-1)!.stylistIds).toEqual([VALERIA, SARA]);
    });

    it('nunca lo que la profesional no sabe hacer', async () => {
      await onlyCuts(VALERIA);
      const turn = await walkIn({ serviceIds: [COLOR] });

      await expect(
        callTurn.execute({ turnId: turn.id, stylistId: VALERIA, actorId: 'reception' }),
      ).rejects.toMatchObject({ code: 'SERVICE_NOT_ASSIGNED' });
    });

    it('ni a una profesional que ya tiene clienta', async () => {
      await walkIn();
      const second = await walkIn({ clientName: 'Otra' });
      await callNext.execute({ stylistId: SARA, actorId: 'sara' });

      await expect(
        callTurn.execute({ turnId: second.id, stylistId: SARA, actorId: 'reception' }),
      ).rejects.toMatchObject({ code: 'QUEUE_STYLIST_BUSY' });
    });
  });

  // ===========================================================================

  describe('entre la llamada y el final', () => {
    const calledBySara = async () => {
      await walkIn();
      return (await callNext.execute({ stylistId: SARA, actorId: 'sara' }))!;
    };

    it('volver a llamar sube el contador para que la pantalla la anuncie', async () => {
      const turn = await calledBySara();
      clock.advanceBy(60_000);

      const recalled = await change.execute({
        turnId: turn.id,
        action: 'recall',
        actorId: 'sara',
        restrictToStylistId: SARA,
      });

      expect(recalled.callCount).toBe(2);
      expect(audit.entries.at(-1)).toMatchObject({
        before: { status: 'CALLED' },
        after: { action: 'recall', status: 'CALLED', callCount: 2 },
      });
    });

    it('empezar, y no vino', async () => {
      const turn = await calledBySara();
      const started = await change.execute({
        turnId: turn.id,
        action: 'start',
        actorId: 'sara',
        restrictToStylistId: null,
      });
      expect(started.status).toBe('IN_SERVICE');

      await walkIn({ clientName: 'Ausente' });
      const absent = (await callNext.execute({ stylistId: VALERIA, actorId: 'valeria' }))!;
      const noShow = await change.execute({
        turnId: absent.id,
        action: 'no-show',
        actorId: 'valeria',
        restrictToStylistId: VALERIA,
      });
      expect(noShow.status).toBe('NO_SHOW');
    });

    it('devolverla a la fila avisa también a quien la tenía', async () => {
      const turn = await calledBySara();

      const back = await change.execute({
        turnId: turn.id,
        action: 'requeue',
        actorId: 'sara',
        restrictToStylistId: SARA,
      });

      expect(back.status).toBe('WAITING');
      expect(events.published.at(-1)).toMatchObject({ status: 'WAITING', stylistIds: [SARA] });
    });

    it('cancelar con motivo', async () => {
      const turn = await walkIn();

      const cancelled = await change.execute({
        turnId: turn.id,
        action: 'cancel',
        reason: 'Se fue',
        actorId: 'reception',
        restrictToStylistId: null,
      });

      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Se fue' });
    });

    it('la profesional no toca turnos ajenos: para ella no existen', async () => {
      const turn = await calledBySara();

      await expect(
        change.execute({
          turnId: turn.id,
          action: 'no-show',
          actorId: 'valeria',
          restrictToStylistId: VALERIA,
        }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });

    it('si otra persona cambió el turno antes, falla en vez de pisarlo', async () => {
      const turn = await calledBySara();
      turns.stolen.add(turn.id);

      await expect(
        change.execute({
          turnId: turn.id,
          action: 'start',
          actorId: 'sara',
          restrictToStylistId: SARA,
        }),
      ).rejects.toMatchObject({ code: 'QUEUE_TURN_CHANGED' });
    });
  });

  // ===========================================================================

  describe('terminar', () => {
    const inService = async () => {
      await walkIn({ clientId: ANA });
      return (await callNext.execute({ stylistId: SARA, actorId: 'sara' }))!;
    };

    it('crea la comanda a nombre de quien atendió y cierra el turno con ella', async () => {
      const turn = await inService();
      clock.advanceBy(45 * 60_000);

      const { turn: done, ticket } = await finish.execute({
        tenantId: TENANT,
        turnId: turn.id,
        serviceIds: [CUT, COLOR],
        notes: 'Usó su tinte',
        actorId: 'sara',
        restrictToStylistId: SARA,
      });

      expect(registerTicket.execute).toHaveBeenCalledWith({
        tenantId: TENANT,
        stylistId: SARA,
        serviceIds: [CUT, COLOR],
        clientId: ANA,
        clientName: 'Ana García',
        notes: 'Usó su tinte',
        actorId: 'sara',
      });
      expect(done).toMatchObject({ status: 'DONE', serviceTicketId: ticket.id });
      expect(events.published.at(-1)).toMatchObject({ status: 'DONE', stylistIds: [SARA] });
    });

    it('recepción puede terminarlo por la profesional', async () => {
      const turn = await inService();

      await finish.execute({
        tenantId: TENANT,
        turnId: turn.id,
        serviceIds: [CUT],
        actorId: 'reception',
        restrictToStylistId: null,
      });

      expect(registerTicket.execute).toHaveBeenCalledWith(
        expect.objectContaining({ stylistId: SARA, notes: null }),
      );
    });

    it('un turno que no está en atención no crea comanda', async () => {
      const waiting = await walkIn();

      await expect(
        finish.execute({
          tenantId: TENANT,
          turnId: waiting.id,
          serviceIds: [CUT],
          actorId: 'reception',
          restrictToStylistId: null,
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);
      expect(registerTicket.execute).not.toHaveBeenCalled();
    });

    it('la profesional no termina el turno de otra', async () => {
      const turn = await inService();

      await expect(
        finish.execute({
          tenantId: TENANT,
          turnId: turn.id,
          serviceIds: [CUT],
          actorId: 'valeria',
          restrictToStylistId: VALERIA,
        }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(registerTicket.execute).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================

  describe('tablero', () => {
    it('recepción ve toda la fila con nombres y el puesto de cada una', async () => {
      await walkIn({ clientName: 'Primera', preferredStylistId: SARA });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Segunda', serviceIds: [CUT, COLOR] });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Tercera' });
      await callNext.execute({ stylistId: VALERIA, actorId: 'valeria' });

      const { businessDate, turns: views } = await board.execute({ restrictToStylistId: null });

      expect(businessDate).toBe(TODAY);
      expect(
        views.map((view) => [view.turn.clientName, view.position, view.preferredStylistName]),
      ).toEqual([
        ['Primera', 1, 'Sara'],
        ['Segunda', null, null],
        ['Tercera', 2, null],
      ]);
      expect(views[1]).toMatchObject({
        serviceNames: ['Corte', 'Tinte'],
        stylistName: 'Valeria',
      });
    });

    it('la profesional ve lo que puede atender y lo suyo, con el puesto de la fila entera', async () => {
      await onlyCuts(VALERIA);
      await walkIn({ clientName: 'Pide a Sara', preferredStylistId: SARA });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Tinte', serviceIds: [COLOR] });
      clock.advanceBy(60_000);
      await walkIn({ clientName: 'Corte' });

      const forValeria = await board.execute({ restrictToStylistId: VALERIA });

      expect(forValeria.turns.map((view) => [view.turn.clientName, view.position])).toEqual([
        ['Corte', 3],
      ]);

      await callNext.execute({ stylistId: VALERIA, actorId: 'valeria' });
      const after = await board.execute({ restrictToStylistId: VALERIA });
      expect(after.turns.map((view) => view.turn.status)).toEqual(['CALLED']);
    });

    it('sin ficha profesional no se ve nada', async () => {
      await walkIn();
      const view = await board.execute({ restrictToStylistId: '__sin_ficha_profesional__' });
      expect(view.turns).toEqual([]);
    });

    it('sigue enseñando a la profesional el turno que dejó abierto ayer', async () => {
      await walkIn();
      await callNext.execute({ stylistId: SARA, actorId: 'sara' });
      clock.advanceBy(24 * 60 * 60_000);

      const today = await board.execute({ restrictToStylistId: SARA });

      expect(today.turns.map((view) => [view.turn.businessDate, view.turn.status])).toEqual([
        [TODAY, 'CALLED'],
      ]);
    });

    it('un turno cerrado de otro día se describe sin puesto', async () => {
      const turn = await walkIn();
      await change.execute({
        turnId: turn.id,
        action: 'cancel',
        actorId: 'reception',
        restrictToStylistId: null,
      });
      clock.advanceBy(24 * 60 * 60_000);

      const view = await board.viewOf(await turns.findByIdOrFail(turn.id));

      expect(view).toMatchObject({ position: null, serviceNames: ['Corte'] });
    });

    it('nombra lo que ya no existe sin romper la fila', async () => {
      const ghost = QueueTurn.register({
        id: 'ghost',
        tenantId: TENANT,
        businessDate: TODAY,
        number: 9,
        clientName: 'Fantasma',
        serviceIds: ['retired'],
        preferredStylistId: 'stylist-gone',
        now: NOW,
        actorId: null,
      });
      turns.put(ghost);

      const [view] = (await board.execute({ restrictToStylistId: null })).turns;

      expect(view).toMatchObject({
        serviceNames: ['Servicio retirado'],
        preferredStylistName: 'Profesional',
      });
    });
  });

  describe('espera de hoy', () => {
    /** Anota y llama a una clienta que esperó `minutes`. */
    const waited = async (minutes: number, stylistId: string) => {
      const turn = await walkIn({ clientName: `Esperó ${minutes}` });
      clock.advanceBy(minutes * 60_000);
      await callTurn.execute({ turnId: turn.id, stylistId, actorId: 'reception' });
      const called = await turns.findByIdOrFail(turn.id);
      // Se cierra para dejar libre a la profesional; la espera ya quedó medida.
      await change.execute({
        turnId: called.id,
        action: 'no-show',
        actorId: 'reception',
        restrictToStylistId: null,
      });
    };

    it('el tablero da la media de hoy en cuanto llaman a alguien', async () => {
      expect(await board.execute({ restrictToStylistId: null })).toMatchObject({
        averageWaitMinutes: null,
        waitSamples: 0,
      });

      await waited(10, SARA);
      await waited(20, SARA);

      expect(await board.execute({ restrictToStylistId: null })).toMatchObject({
        averageWaitMinutes: 15,
        waitSamples: 2,
      });
    });

    it('la pantalla solo da una espera aproximada con varias llamadas', async () => {
      await waited(10, SARA);
      await waited(20, SARA);
      expect((await display.execute({ salonName: 'Salón' })).estimatedWaitMinutes).toBeNull();

      await waited(30, VALERIA);
      expect((await display.execute({ salonName: 'Salón' })).estimatedWaitMinutes).toBe(20);
    });
  });

  describe('indicadores', () => {
    const fact = (overrides: Partial<QueueTurnFact>): QueueTurnFact => ({
      businessDate: '2026-10-11',
      status: 'DONE',
      createdAt: new Date('2026-10-11T15:00:00.000Z'),
      firstCalledAt: new Date('2026-10-11T15:10:00.000Z'),
      startedAt: new Date('2026-10-11T15:10:00.000Z'),
      closedAt: new Date('2026-10-11T15:40:00.000Z'),
      stylistId: SARA,
      preferredStylistId: null,
      serviceIds: [CUT],
      charged: null,
      ...overrides,
    });

    it('pide el último mes por defecto y pone nombre a profesionales y servicios', async () => {
      const reader = {
        factsBetween: jest.fn(async (_from: string, _to: string) => [
          fact({}),
          fact({ stylistId: 'stylist-gone', serviceIds: ['retired'] }),
        ]),
      };
      const stats = new GetQueueStatsUseCase(reader, stylists, services, settings, clock);

      const view = await stats.execute({});

      expect(reader.factsBetween).toHaveBeenCalledWith('2026-09-13', TODAY);
      expect(view.stats).toMatchObject({ arrivals: 2, attended: 2 });
      expect(view.stylistNames.get(SARA)).toBe('Sara');
      expect(view.stylistNames.has('stylist-gone')).toBe(false);
      expect(view.serviceNames.get(CUT)).toBe('Corte');
    });

    it('respeta el periodo pedido', async () => {
      const reader = { factsBetween: jest.fn(async (_from: string, _to: string) => []) };
      const stats = new GetQueueStatsUseCase(reader, stylists, services, settings, clock);

      await stats.execute({ from: '2026-10-01', to: '2026-10-07' });

      expect(reader.factsBetween).toHaveBeenCalledWith('2026-10-01', '2026-10-07');
    });
  });

  describe('pantalla de la sala', () => {
    it('enseña las últimas llamadas primero, el nombre corto y la fila por números', async () => {
      for (let index = 1; index <= 16; index += 1) {
        await walkIn({ clientName: `Clienta${index} Pérez` });
        clock.advanceBy(1_000);
      }
      await callNext.execute({ stylistId: SARA, actorId: 'sara' });
      clock.advanceBy(60_000);
      await callNext.execute({ stylistId: VALERIA, actorId: 'valeria' });

      const screen = await display.execute({ salonName: 'Marian Salón' });

      expect(screen.salonName).toBe('Marian Salón');
      expect(screen.called.map((call) => [call.number, call.publicName, call.stylistName])).toEqual(
        [
          [2, 'Clienta2 P.', 'Valeria'],
          [1, 'Clienta1 P.', 'Sara'],
        ],
      );
      expect(screen.waitingCount).toBe(14);
      expect(screen.waiting).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    });

    it('no anuncia lo que quedó llamado de otro día', async () => {
      await walkIn();
      await callNext.execute({ stylistId: SARA, actorId: 'sara' });
      clock.advanceBy(24 * 60 * 60_000);

      const screen = await display.execute({ salonName: 'Marian Salón' });

      expect(screen.called).toEqual([]);
    });

    it('si la profesional ya no existe, dice «Profesional»', async () => {
      const turn = QueueTurn.register({
        id: 'orphan',
        tenantId: TENANT,
        businessDate: TODAY,
        number: 1,
        clientName: 'Ana García',
        now: NOW,
        actorId: null,
      });
      turn.call('stylist-gone', NOW, null);
      turns.put(turn);

      const screen = await display.execute({ salonName: 'Marian Salón' });

      expect(screen.called[0]).toMatchObject({ publicName: 'Ana G.', stylistName: 'Profesional' });
    });
  });

  describe('enlace de la pantalla', () => {
    it('guarda solo el hash, retira el anterior y no deja el enlace en la auditoría', async () => {
      const links = new InMemoryQueueDisplayLinks();
      const issue = new IssueQueueDisplayLinkUseCase(links, audit);

      const first = await issue.execute({ tenantId: TENANT });
      const second = await issue.execute({ tenantId: TENANT });

      expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(second).not.toBe(first);
      expect(links.digests.get(TENANT)).toBe(displayTokenDigest(second));
      await expect(links.findSalonByDigest(displayTokenDigest(first))).resolves.toBeNull();
      expect(JSON.stringify(audit.entries)).not.toContain(second);
    });
  });
});
