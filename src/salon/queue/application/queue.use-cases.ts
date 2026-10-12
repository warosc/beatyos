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
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/domain/ports/repository.port';
import { AGENDA_EVENTS, type AgendaEvents } from '../../appointments/domain/agenda.ports';
import {
  SERVICE_REPOSITORY,
  type ServiceRepository,
} from '../../catalog/domain/catalog.repositories';
import { CLIENT_REPOSITORY, type ClientRepository } from '../../clients/domain/client.repository';
import { RegisterServiceTicketUseCase } from '../../service-tickets/application/service-ticket.use-cases';
import type { ServiceTicket } from '../../service-tickets/domain/service-ticket.entity';
import type { Stylist } from '../../stylists/domain/stylist.entity';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import {
  businessDateOf,
  candidatesFor,
  QueueTurn,
  type QueueTurnStatusValue,
} from '../domain/queue-turn.entity';
import {
  QUEUE_SETTINGS,
  QUEUE_TURN_REPOSITORY,
  type QueueSettings,
  type QueueTurnRepository,
} from '../domain/queue.ports';

/**
 * Aviso en vivo de que la fila cambió (ADR-0024).
 *
 * Viaja por el mismo canal que la agenda: recepción y las profesionales ya lo tienen abierto
 * todo el día, y una segunda conexión por pestaña no aporta nada. Como los de la agenda, no
 * lleva datos de la clienta; quien lo recibe vuelve a pedir la fila con sus permisos.
 */
const announce = (
  events: AgendaEvents,
  turn: QueueTurn,
  now: Date,
  ...extraStylistIds: (string | null)[]
): void => {
  const stylistIds = [turn.stylistId, turn.preferredStylistId, ...extraStylistIds].filter(
    (id): id is string => !!id,
  );
  events.publish({
    tenantId: turn.tenantId,
    kind: 'queue',
    stylistIds: [...new Set(stylistIds)],
    status: turn.status,
    at: now,
  });
};

/** La profesional existe, está activa y no tiene a otra clienta llamada o en el sillón. */
async function assertFreeToAttend(stylist: Stylist, turns: QueueTurnRepository): Promise<void> {
  if (!stylist.isBookable()) {
    throw new BusinessRuleViolationError(
      'STYLIST_NOT_ACTIVE',
      `${stylist.displayName} no está activa y no puede atender la fila`,
      { stylistId: stylist.id },
    );
  }

  const active = await turns.findActiveByStylist(stylist.id);
  if (active) {
    throw new ConflictError(
      'QUEUE_STYLIST_BUSY',
      `${stylist.displayName} ya está con ${active.clientName} (turno ${active.number}). ` +
        'Termina o devuelve ese turno antes de llamar a otra clienta.',
      { stylistId: stylist.id, turnId: active.id },
    );
  }
}

// ===========================================================================
// Anotar en la fila
// ===========================================================================

export interface RegisterWalkInInput {
  readonly tenantId: string;
  /** Ficha de la clienta, si la tiene. Con ella se usa el nombre de la ficha. */
  readonly clientId?: string | null;
  /** Solo para la clienta de paso, sin ficha. */
  readonly clientName?: string | null;
  readonly serviceIds?: readonly string[];
  readonly preferredStylistId?: string | null;
  readonly notes?: string | null;
  readonly actorId: string;
}

/**
 * Recepción anota a una clienta que llega sin cita. Recibe el siguiente número del día.
 *
 * Lo que pide se comprueba ya —servicios activos, y que la profesional que pide los haga—
 * para que no espere media hora a alguien que no la puede atender.
 */
@Injectable()
export class RegisterWalkInUseCase implements UseCase<RegisterWalkInInput, QueueTurn> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(QUEUE_SETTINGS) private readonly settings: QueueSettings,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: RegisterWalkInInput): Promise<QueueTurn> {
    const serviceIds = input.serviceIds ?? [];
    const now = this.clock.now();
    const businessDate = businessDateOf(now, this.settings.timeZone);

    const created = await this.uow.execute(async () => {
      const clientName = input.clientId
        ? await this.clientNameIfNotQueued(input.clientId, businessDate)
        : (input.clientName ?? '');

      await this.assertRequestable(serviceIds, input.preferredStylistId ?? null);

      const turn = QueueTurn.register({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        businessDate,
        number: await this.turns.nextNumber(businessDate),
        clientId: input.clientId ?? null,
        clientName,
        serviceIds,
        preferredStylistId: input.preferredStylistId ?? null,
        notes: input.notes ?? null,
        now,
        actorId: input.actorId,
      });

      return this.turns.create(turn);
    });

    await this.audit.record({
      action: 'CREATE',
      entityType: 'QueueTurn',
      entityId: created.id,
      after: {
        number: created.number,
        businessDate: created.businessDate,
        clientId: created.clientId,
        preferredStylistId: created.preferredStylistId,
        services: created.serviceIds.length,
      },
    });
    announce(this.events, created, now);

    return created;
  }

  /**
   * Nombre de la ficha, si no está ya en la fila. Anotarla dos veces —un doble toque, dos
   * personas en recepción— la haría llamar dos veces.
   */
  private async clientNameIfNotQueued(clientId: string, businessDate: string): Promise<string> {
    const client = await this.clients.findByIdOrFail(clientId);
    const queued = (await this.turns.listForBoard(businessDate)).find(
      (turn) => turn.clientId === clientId && (turn.status === 'WAITING' || turn.isActive),
    );
    if (queued) {
      throw new ConflictError(
        'QUEUE_CLIENT_ALREADY_WAITING',
        `${client.name.full} ya está en la fila con el turno ${queued.number}`,
        { turnId: queued.id, number: queued.number },
      );
    }
    return client.name.full;
  }

  private async assertRequestable(
    serviceIds: readonly string[],
    preferredStylistId: string | null,
  ): Promise<void> {
    const services = await this.services.findManyByIds(serviceIds);
    const byId = new Map(services.map((service) => [service.id, service]));

    for (const serviceId of serviceIds) {
      const service = byId.get(serviceId);
      if (!service) throw new EntityNotFoundError('Servicio', serviceId);
      if (!service.isActive) {
        throw new BusinessRuleViolationError(
          'ITEM_NOT_AVAILABLE',
          `${service.name} está dado de baja`,
          { serviceId },
        );
      }
    }

    if (!preferredStylistId) return;

    const stylist = await this.stylists.findByIdOrFail(preferredStylistId);
    if (!stylist.isBookable()) {
      throw new BusinessRuleViolationError(
        'STYLIST_NOT_ACTIVE',
        `${stylist.displayName} no está activa`,
        { stylistId: stylist.id },
      );
    }
    const missing = serviceIds.find((serviceId) => !stylist.canPerform(serviceId));
    if (missing) {
      throw new BusinessRuleViolationError(
        'SERVICE_NOT_ASSIGNED',
        `${byId.get(missing)!.name} no está entre los servicios de ${stylist.displayName}`,
        { serviceId: missing, stylistId: stylist.id },
      );
    }
  }
}

// ===========================================================================
// Llamar
// ===========================================================================

export interface CallNextInput {
  readonly stylistId: string;
  readonly actorId: string;
}

/**
 * «Llamar siguiente»: la profesional queda libre y se lleva a la primera de la fila que
 * puede atender. Devuelve `null` si no hay nadie para ella.
 *
 * Si otra profesional se lleva a esa clienta en el mismo instante, la escritura condicional
 * lo detecta y se pasa a la siguiente candidata: ninguna de las dos se queda sin clienta
 * mientras quede alguien en la fila para ella.
 */
@Injectable()
export class CallNextUseCase implements UseCase<CallNextInput, QueueTurn | null> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(QUEUE_SETTINGS) private readonly settings: QueueSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: CallNextInput): Promise<QueueTurn | null> {
    const stylist = await this.stylists.findByIdOrFail(input.stylistId);
    await assertFreeToAttend(stylist, this.turns);

    const now = this.clock.now();
    const waiting = await this.turns.listWaiting(businessDateOf(now, this.settings.timeZone));

    for (const candidate of candidatesFor(waiting, stylist)) {
      candidate.call(stylist.id, now, input.actorId);
      let called: QueueTurn;
      try {
        called = await this.turns.update(candidate, 'WAITING');
      } catch (error) {
        if (error instanceof ConflictError && error.code === 'QUEUE_TURN_CHANGED') continue;
        throw error;
      }

      await recordCall(this.audit, called);
      announce(this.events, called, now);
      return called;
    }

    return null;
  }
}

export interface CallTurnInput {
  readonly turnId: string;
  readonly stylistId: string;
  readonly actorId: string;
}

/**
 * Recepción asigna un turno concreto a una profesional: la clienta que pidió a Sara acepta
 * ir con Valeria porque Sara va a tardar.
 *
 * Se salta la preferencia, que es de la clienta y ella ya cambió de idea; nunca la
 * habilidad, que es del salón.
 */
@Injectable()
export class CallTurnUseCase implements UseCase<CallTurnInput, QueueTurn> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: CallTurnInput): Promise<QueueTurn> {
    const [turn, stylist] = await Promise.all([
      this.turns.findByIdOrFail(input.turnId),
      this.stylists.findByIdOrFail(input.stylistId),
    ]);

    if (!turn.canBePerformedBy(stylist)) {
      throw new BusinessRuleViolationError(
        'SERVICE_NOT_ASSIGNED',
        `${stylist.displayName} no hace todo lo que pidió ${turn.clientName}`,
        { turnId: turn.id, stylistId: stylist.id },
      );
    }
    await assertFreeToAttend(stylist, this.turns);

    const now = this.clock.now();
    turn.call(stylist.id, now, input.actorId);
    const called = await this.turns.update(turn, 'WAITING');

    await recordCall(this.audit, called);
    announce(this.events, called, now);
    return called;
  }
}

const recordCall = (audit: AuditRecorder, turn: QueueTurn): Promise<void> =>
  audit.record({
    action: 'UPDATE',
    entityType: 'QueueTurn',
    entityId: turn.id,
    after: { status: turn.status, stylistId: turn.stylistId, callCount: turn.callCount },
  });

// ===========================================================================
// Cambios de estado
// ===========================================================================

export type QueueTurnAction = 'recall' | 'start' | 'no-show' | 'requeue' | 'cancel';

export interface ChangeQueueTurnInput {
  readonly turnId: string;
  readonly action: QueueTurnAction;
  /** Solo para `cancel`. */
  readonly reason?: string | null;
  readonly actorId: string;
  /** Con `queue.attend.own`: solo los turnos que esta profesional tiene llamados. */
  readonly restrictToStylistId: string | null;
}

/**
 * Lo que pasa con un turno entre la llamada y el final: volver a llamar, empezar, no se
 * presentó, devolverlo a la fila o cancelarlo.
 *
 * La profesional solo toca los turnos que ella llamó; uno ajeno se trata como inexistente,
 * igual que una cita ajena, para no confirmar que el identificador existe.
 */
@Injectable()
export class ChangeQueueTurnUseCase implements UseCase<ChangeQueueTurnInput, QueueTurn> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: ChangeQueueTurnInput): Promise<QueueTurn> {
    const turn = await this.turns.findByIdOrFail(input.turnId);
    if (input.restrictToStylistId && turn.stylistId !== input.restrictToStylistId) {
      throw new EntityNotFoundError('Turno', input.turnId);
    }

    const now = this.clock.now();
    const before: QueueTurnStatusValue = turn.status;
    const previousStylistId = turn.stylistId;

    switch (input.action) {
      case 'recall':
        turn.recall(now, input.actorId);
        break;
      case 'start':
        turn.start(now, input.actorId);
        break;
      case 'no-show':
        turn.markNoShow(now, input.actorId);
        break;
      case 'requeue':
        turn.requeue(now, input.actorId);
        break;
      case 'cancel':
        turn.cancel(input.reason, now, input.actorId);
        break;
    }

    const saved = await this.turns.update(turn, before);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'QueueTurn',
      entityId: saved.id,
      before: { status: before },
      after: {
        action: input.action,
        status: saved.status,
        callCount: saved.callCount,
        reason: saved.cancellationReason,
      },
    });
    announce(this.events, saved, now, previousStylistId);
    return saved;
  }
}

// ===========================================================================
// Terminar
// ===========================================================================

export interface FinishQueueTurnInput {
  readonly tenantId: string;
  readonly turnId: string;
  /** Lo que de verdad le hizo. Puede diferir de lo que pidió al llegar. */
  readonly serviceIds: readonly string[];
  readonly notes?: string | null;
  readonly actorId: string;
  readonly restrictToStylistId: string | null;
}

export interface FinishQueueTurnResult {
  readonly turn: QueueTurn;
  readonly ticket: ServiceTicket;
}

/**
 * La profesional termina y declara lo que hizo: se crea la comanda y el turno se cierra con
 * ella, en la misma transacción.
 *
 * La comanda sale de `RegisterServiceTicketUseCase`, el mismo que usa «Clienta sin cita» en
 * «Mi día»: servicios activos y asignados a la profesional, y caja la ve al instante. Si el
 * turno ya no estaba en atención —otra persona lo cerró—, la comanda se deshace con él.
 */
@Injectable()
export class FinishQueueTurnUseCase implements UseCase<
  FinishQueueTurnInput,
  FinishQueueTurnResult
> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    private readonly registerTicket: RegisterServiceTicketUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AGENDA_EVENTS) private readonly events: AgendaEvents,
  ) {}

  async execute(input: FinishQueueTurnInput): Promise<FinishQueueTurnResult> {
    const result = await this.uow.execute(async () => {
      const turn = await this.turns.findByIdOrFail(input.turnId);
      if (input.restrictToStylistId && turn.stylistId !== input.restrictToStylistId) {
        throw new EntityNotFoundError('Turno', input.turnId);
      }
      // Antes de crear la comanda: un turno cerrado no debe dejar una comanda huérfana ni
      // un mensaje sobre la comanda cuando el problema es el turno.
      if (!turn.isActive || !turn.stylistId) {
        throw new InvalidStateTransitionError('Turno', turn.status, 'DONE');
      }

      const before = turn.status;
      const ticket = await this.registerTicket.execute({
        tenantId: input.tenantId,
        stylistId: turn.stylistId,
        serviceIds: input.serviceIds,
        clientId: turn.clientId,
        clientName: turn.clientName,
        notes: input.notes ?? null,
        actorId: input.actorId,
      });

      turn.finish(ticket.id, this.clock.now(), input.actorId);
      return { turn: await this.turns.update(turn, before), ticket };
    });

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'QueueTurn',
      entityId: result.turn.id,
      after: { status: result.turn.status, serviceTicketId: result.ticket.id },
    });
    announce(this.events, result.turn, this.clock.now());
    return result;
  }
}
