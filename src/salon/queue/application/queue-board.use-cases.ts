import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  type AuditRecorder,
  type Clock,
  type UseCase,
} from '../../../shared/application/ports';
import {
  SERVICE_REPOSITORY,
  type ServiceRepository,
} from '../../catalog/domain/catalog.repositories';
import type { Stylist } from '../../stylists/domain/stylist.entity';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../stylists/domain/stylist.repository';
import { MIN_SAMPLES, summarizeMinutes, waitMinutes } from '../domain/queue-stats';
import { businessDateOf, byArrival, type QueueTurn } from '../domain/queue-turn.entity';
import {
  QUEUE_DISPLAY_LINKS,
  QUEUE_SETTINGS,
  QUEUE_TURN_REPOSITORY,
  type QueueDisplayLinks,
  type QueueSettings,
  type QueueTurnRepository,
} from '../domain/queue.ports';

// ===========================================================================
// Tablero
// ===========================================================================

export interface QueueTurnView {
  readonly turn: QueueTurn;
  /** Puesto en la fila (1 = la siguiente). Solo en espera. */
  readonly position: number | null;
  readonly serviceNames: readonly string[];
  readonly stylistName: string | null;
  readonly preferredStylistName: string | null;
}

export interface QueueBoard {
  readonly businessDate: string;
  readonly turns: readonly QueueTurnView[];
  /** Espera media de hoy, de la llegada a la primera llamada. `null` si aún no llamaron a nadie. */
  readonly averageWaitMinutes: number | null;
  readonly waitSamples: number;
}

/**
 * Espera media de hoy. Es lo que se le puede decir a quien llega —«ahora mismo se espera
 * unos 20 minutos»—, que es más honesto que prometer una hora calculada.
 */
const todaysWait = (turns: readonly QueueTurn[], businessDate: string) =>
  summarizeMinutes(
    turns
      .filter((turn) => turn.businessDate === businessDate)
      .map(waitMinutes)
      .filter((value): value is number => value !== null),
  );

export interface GetQueueBoardInput {
  /**
   * Con `queue.read.own`: la profesional ve las que **ella** puede atender y las suyas, no la
   * fila entera. Es la misma regla que decide a quién llama «siguiente».
   */
  readonly restrictToStylistId: string | null;
}

/**
 * La fila del día con todo lo que recepción necesita para pintarla: nombres de servicios y
 * profesionales, y el puesto de cada una en espera.
 */
@Injectable()
export class GetQueueBoardUseCase implements UseCase<GetQueueBoardInput, QueueBoard> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    @Inject(SERVICE_REPOSITORY) private readonly services: ServiceRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(QUEUE_SETTINGS) private readonly settings: QueueSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: GetQueueBoardInput): Promise<QueueBoard> {
    const businessDate = businessDateOf(this.clock.now(), this.settings.timeZone);
    const all = await this.turns.listForBoard(businessDate);

    // El puesto se calcula sobre la fila entera, antes de filtrar: «eres la tercera» tiene
    // que significar lo mismo para recepción y para la profesional.
    const positions = new Map(
      all
        .filter((turn) => turn.status === 'WAITING')
        .sort(byArrival)
        .map((turn, index) => [turn.id, index + 1]),
    );

    const visible = input.restrictToStylistId
      ? await this.ownView(all, input.restrictToStylistId)
      : all;

    const wait = todaysWait(all, businessDate);
    return {
      businessDate,
      turns: await this.describe(visible, positions),
      averageWaitMinutes: wait.average,
      waitSamples: wait.samples,
    };
  }

  /**
   * Un turno como lo pinta la fila: con nombres y su puesto. Lo usan las respuestas de las
   * acciones, para que la pantalla que actúa no tenga que volver a pedir la fila.
   */
  async viewOf(turn: QueueTurn): Promise<QueueTurnView> {
    const board = await this.execute({ restrictToStylistId: null });
    const found = board.turns.find((view) => view.turn.id === turn.id);
    if (found) return found;
    // Un turno cerrado de otro día no está en la fila de hoy: va sin puesto.
    const [view] = await this.describe([turn], new Map());
    return view;
  }

  private async ownView(all: readonly QueueTurn[], stylistId: string): Promise<QueueTurn[]> {
    const stylist = await this.stylists.findById(stylistId);
    // Sin ficha —el marcador de «.own sin profesional»— no se ve nada en lugar de verlo todo.
    if (!stylist) return [];
    return all.filter((turn) => turn.stylistId === stylist.id || turn.canBeAttendedBy(stylist));
  }

  private async describe(
    turns: readonly QueueTurn[],
    positions: ReadonlyMap<string, number>,
  ): Promise<QueueTurnView[]> {
    const serviceIds = [...new Set(turns.flatMap((turn) => turn.serviceIds))];
    const stylistIds = [
      ...new Set(
        turns.flatMap((turn) => [turn.stylistId, turn.preferredStylistId]).filter((id) => !!id),
      ),
    ] as string[];

    const [services, stylists] = await Promise.all([
      this.services.findManyByIds(serviceIds),
      // Un salón tiene un puñado de profesionales: no justifica un `findManyByIds` propio.
      Promise.all(stylistIds.map((id) => this.stylists.findById(id))),
    ]);
    const serviceName = new Map(services.map((service) => [service.id, service.name]));
    const stylistName = new Map(
      stylists
        .filter((stylist): stylist is Stylist => stylist !== null)
        .map((stylist) => [stylist.id, stylist.displayName]),
    );
    const nameOf = (id: string | null) => (id ? (stylistName.get(id) ?? 'Profesional') : null);

    return turns.map((turn) => ({
      turn,
      position: positions.get(turn.id) ?? null,
      serviceNames: turn.serviceIds.map((id) => serviceName.get(id) ?? 'Servicio retirado'),
      stylistName: nameOf(turn.stylistId),
      preferredStylistName: nameOf(turn.preferredStylistId),
    }));
  }
}

// ===========================================================================
// Pantalla del salón
// ===========================================================================

/** Llamadas que la pantalla muestra a la vez. Más no se leen desde la sala. */
const DISPLAY_CALLED = 4;
/** Números en espera que la pantalla enumera; del resto solo dice cuántas son. */
const DISPLAY_WAITING = 12;

export interface QueueDisplayCall {
  readonly id: string;
  readonly number: number;
  readonly publicName: string;
  readonly stylistName: string;
  readonly callCount: number;
  readonly calledAt: Date;
}

export interface QueueDisplay {
  readonly salonName: string;
  readonly called: readonly QueueDisplayCall[];
  readonly waiting: readonly number[];
  readonly waitingCount: number;
  /**
   * Espera aproximada que enseña la sala: la media de hoy. Solo con varias llamadas: con una,
   * sería la anécdota de una clienta y no una referencia.
   */
  readonly estimatedWaitMinutes: number | null;
}

/**
 * Lo que enseña la pantalla de la sala: a quién se acaba de llamar y con quién, y cuántas
 * esperan. Nada más.
 *
 * Es la única lectura pública de la fila, así que su respuesta es deliberadamente pobre: el
 * nombre corto («Ana G.»), el número y la profesional. Ni servicios, ni teléfono, ni ficha.
 */
@Injectable()
export class GetQueueDisplayUseCase implements UseCase<{ salonName: string }, QueueDisplay> {
  constructor(
    @Inject(QUEUE_TURN_REPOSITORY) private readonly turns: QueueTurnRepository,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(QUEUE_SETTINGS) private readonly settings: QueueSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: { salonName: string }): Promise<QueueDisplay> {
    const businessDate = businessDateOf(this.clock.now(), this.settings.timeZone);
    const today = (await this.turns.listForBoard(businessDate)).filter(
      (turn) => turn.businessDate === businessDate,
    );

    const called = today
      .filter((turn) => turn.status === 'CALLED' && turn.calledAt && turn.stylistId)
      .sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime())
      .slice(0, DISPLAY_CALLED);
    const waiting = today.filter((turn) => turn.status === 'WAITING').sort(byArrival);
    const wait = todaysWait(today, businessDate);

    const names = new Map(
      (await Promise.all(called.map((turn) => this.stylists.findById(turn.stylistId!))))
        .filter((stylist): stylist is Stylist => stylist !== null)
        .map((stylist) => [stylist.id, stylist.displayName]),
    );

    return {
      salonName: input.salonName,
      called: called.map((turn) => ({
        id: turn.id,
        number: turn.number,
        publicName: turn.publicName,
        stylistName: names.get(turn.stylistId!) ?? 'Profesional',
        callCount: turn.callCount,
        calledAt: turn.calledAt!,
      })),
      waiting: waiting.slice(0, DISPLAY_WAITING).map((turn) => turn.number),
      waitingCount: waiting.length,
      estimatedWaitMinutes: wait.samples >= MIN_SAMPLES ? wait.average : null,
    };
  }
}

// ---------------------------------------------------------------------------

/** Enlace corto, sin significado y de un solo salón: 144 bits de azar. */
const newToken = () => randomBytes(18).toString('base64url');

/** Hash del enlace de la pantalla. Lo usa el adaptador HTTP para localizar el salón. */
export const displayTokenDigest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/**
 * Emite el enlace de la pantalla de turnos y retira el anterior.
 *
 * El enlace se enseña una vez, al crearlo: solo se guarda su hash. Si se pierde, se emite
 * otro, y la pantalla que tuviera el viejo deja de mostrar la fila. Es también la forma de
 * cortar una pantalla que no debería verla.
 */
@Injectable()
export class IssueQueueDisplayLinkUseCase implements UseCase<{ tenantId: string }, string> {
  constructor(
    @Inject(QUEUE_DISPLAY_LINKS) private readonly links: QueueDisplayLinks,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: { tenantId: string }): Promise<string> {
    const token = newToken();
    await this.links.replace(input.tenantId, displayTokenDigest(token));
    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Tenant',
      entityId: input.tenantId,
      // Nunca el enlace: el registro de auditoría lo leen más personas que la pantalla.
      after: { queueDisplayLink: 'renovado' },
    });
    return token;
  }
}
