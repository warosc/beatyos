import { ConflictError, EntityNotFoundError } from '@shared/domain/errors';
import {
  ACTIVE_QUEUE_STATUSES,
  byArrival,
  QueueTurn,
  type QueueTurnStatusValue,
} from '@salon/queue/domain/queue-turn.entity';
import type {
  QueueDisplayLinks,
  QueueDisplaySalon,
  QueueTurnRepository,
} from '@salon/queue/domain/queue.ports';

/**
 * Fila en memoria con las mismas garantías que PostgreSQL: el cambio de estado solo se
 * escribe si el turno seguía donde se leyó, y una profesional no puede tener dos turnos
 * activos (el índice único parcial de la migración).
 *
 * Guarda copias, no referencias: un caso de uso que modifica la entidad y luego falla al
 * guardar no debe dejar la fila cambiada, igual que no la dejaría la base.
 */
export class InMemoryQueueTurnRepository implements QueueTurnRepository {
  private readonly rows = new Map<string, QueueTurn>();
  private readonly counters = new Map<string, number>();

  /** Simula que otra profesional escribió antes: el siguiente `update` de ese turno falla. */
  readonly stolen = new Set<string>();

  async findByIdOrFail(id: string): Promise<QueueTurn> {
    const row = this.rows.get(id);
    if (!row) throw new EntityNotFoundError('Turno', id);
    return clone(row);
  }

  async findActiveByStylist(stylistId: string): Promise<QueueTurn | null> {
    const row = this.all().find((turn) => turn.stylistId === stylistId && turn.isActive);
    return row ? clone(row) : null;
  }

  async listWaiting(businessDate: string): Promise<QueueTurn[]> {
    return this.all()
      .filter((turn) => turn.businessDate === businessDate && turn.status === 'WAITING')
      .sort(byArrival)
      .map(clone);
  }

  async listForBoard(businessDate: string): Promise<QueueTurn[]> {
    return this.all()
      .filter((turn) => turn.businessDate === businessDate || turn.isActive)
      .sort(byArrival)
      .map(clone);
  }

  async nextNumber(businessDate: string): Promise<number> {
    const next = (this.counters.get(businessDate) ?? 0) + 1;
    this.counters.set(businessDate, next);
    return next;
  }

  async create(turn: QueueTurn): Promise<QueueTurn> {
    this.rows.set(turn.id, clone(turn));
    return clone(turn);
  }

  async update(turn: QueueTurn, expected: QueueTurnStatusValue): Promise<QueueTurn> {
    const current = this.rows.get(turn.id);
    if (!current || current.status !== expected || this.stolen.delete(turn.id)) {
      throw new ConflictError('QUEUE_TURN_CHANGED', 'El turno cambió', { turnId: turn.id });
    }
    const busy =
      ACTIVE_QUEUE_STATUSES.includes(turn.status) &&
      this.all().some(
        (other) => other.id !== turn.id && other.isActive && other.stylistId === turn.stylistId,
      );
    if (busy) throw new ConflictError('QUEUE_STYLIST_BUSY', 'Ya tiene otra clienta');

    this.rows.set(turn.id, clone(turn));
    return clone(turn);
  }

  /** Para preparar escenarios: guarda el turno tal cual, sin pasar por las reglas. */
  put(turn: QueueTurn): void {
    this.rows.set(turn.id, clone(turn));
  }

  all(): QueueTurn[] {
    return [...this.rows.values()];
  }
}

/** Enlaces de pantalla en memoria: un hash por salón, como la columna de `tenants`. */
export class InMemoryQueueDisplayLinks implements QueueDisplayLinks {
  readonly digests = new Map<string, string>();
  readonly names = new Map<string, string>();

  async replace(tenantId: string, tokenDigest: string): Promise<void> {
    this.digests.set(tenantId, tokenDigest);
  }

  async isActive(tenantId: string): Promise<boolean> {
    return this.digests.has(tenantId);
  }

  async findSalonByDigest(tokenDigest: string): Promise<QueueDisplaySalon | null> {
    const entry = [...this.digests.entries()].find(([, digest]) => digest === tokenDigest);
    return entry ? { tenantId: entry[0], name: this.names.get(entry[0]) ?? 'Salón' } : null;
  }
}

const clone = (turn: QueueTurn): QueueTurn =>
  QueueTurn.rehydrate(turn.id, {
    tenantId: turn.tenantId,
    businessDate: turn.businessDate,
    number: turn.number,
    clientId: turn.clientId,
    clientName: turn.clientName,
    serviceIds: [...turn.serviceIds],
    preferredStylistId: turn.preferredStylistId,
    stylistId: turn.stylistId,
    status: turn.status,
    notes: turn.notes,
    callCount: turn.callCount,
    calledAt: turn.calledAt,
    startedAt: turn.startedAt,
    closedAt: turn.closedAt,
    serviceTicketId: turn.serviceTicketId,
    cancellationReason: turn.cancellationReason,
    createdAt: turn.createdAt,
    createdBy: turn.createdBy,
    updatedAt: turn.updatedAt,
    updatedBy: turn.updatedBy,
  });
