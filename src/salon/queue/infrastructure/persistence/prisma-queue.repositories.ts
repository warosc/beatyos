import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictError, EntityNotFoundError } from '../../../../shared/domain/errors';
import { RequestContextStore } from '../../../../shared/infrastructure/context/request-context';
import {
  mapPrismaError,
  withMappedErrors,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import {
  ACTIVE_QUEUE_STATUSES,
  QueueTurn,
  type QueueTurnStatusValue,
} from '../../domain/queue-turn.entity';
import type {
  QueueDisplayLinks,
  QueueDisplaySalon,
  QueueTurnRepository,
} from '../../domain/queue.ports';

type Row = Prisma.QueueTurnGetPayload<object>;

const ENTITY = 'Turno';

/** `AAAA-MM-DD` ↔ columna `DATE`. Prisma la lee y la escribe como medianoche UTC. */
const toDate = (businessDate: string) => new Date(`${businessDate}T00:00:00.000Z`);
const fromDate = (value: Date) => value.toISOString().slice(0, 10);

const ARRIVAL_ORDER: Prisma.QueueTurnOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { number: 'asc' },
];

@Injectable()
export class PrismaQueueTurnRepository implements QueueTurnRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdOrFail(id: string): Promise<QueueTurn> {
    const row = await withMappedErrors(ENTITY, () =>
      this.prisma.client.queueTurn.findFirst({ where: { id } }),
    );
    if (!row) throw new EntityNotFoundError(ENTITY, id);
    return this.toDomain(row);
  }

  async findActiveByStylist(stylistId: string): Promise<QueueTurn | null> {
    const row = await withMappedErrors(ENTITY, () =>
      this.prisma.client.queueTurn.findFirst({
        where: { stylistId, status: { in: [...ACTIVE_QUEUE_STATUSES] } },
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  async listWaiting(businessDate: string): Promise<QueueTurn[]> {
    const rows = await withMappedErrors(ENTITY, () =>
      this.prisma.client.queueTurn.findMany({
        where: { businessDate: toDate(businessDate), status: 'WAITING' },
        orderBy: ARRIVAL_ORDER,
      }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  async listForBoard(businessDate: string): Promise<QueueTurn[]> {
    const rows = await withMappedErrors(ENTITY, () =>
      this.prisma.client.queueTurn.findMany({
        where: {
          OR: [
            { businessDate: toDate(businessDate) },
            { status: { in: [...ACTIVE_QUEUE_STATUSES] } },
          ],
        },
        orderBy: ARRIVAL_ORDER,
      }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Una sola sentencia de PostgreSQL: crea el contador del día o lo incrementa con bloqueo
   * de fila, y devuelve el número. Un `SELECT max(number) + 1` daría el mismo número a dos
   * recepciones que anotan a la vez.
   *
   * No es `upsert` de Prisma porque el filtro de salón que añade la extensión le impide usar
   * el `ON CONFLICT` nativo: lo emula con una lectura y una escritura, y el primer turno del
   * día anotado desde dos sitios a la vez chocaría con la unicidad. Como todo SQL crudo,
   * nombra el salón explícitamente (ADR-0003).
   */
  async nextNumber(businessDate: string): Promise<number> {
    const tenantId = RequestContextStore.tenantId;
    if (!tenantId) throw new EntityNotFoundError('Numeración de turnos', businessDate);

    const [counter] = await withMappedErrors(
      'Numeración de turnos',
      () =>
        this.prisma.client.$queryRaw<{ lastNumber: number }[]>`
        INSERT INTO "queue_day_counters" ("id", "tenantId", "businessDate", "lastNumber", "updatedAt")
        VALUES (${randomUUID()}, ${tenantId}, ${businessDate}::date, 1, now())
        ON CONFLICT ("tenantId", "businessDate")
        DO UPDATE SET "lastNumber" = "queue_day_counters"."lastNumber" + 1, "updatedAt" = now()
        RETURNING "lastNumber"
      `,
    );
    return counter.lastNumber;
  }

  async create(turn: QueueTurn): Promise<QueueTurn> {
    const row = await withMappedErrors(ENTITY, () =>
      this.prisma.client.queueTurn.create({
        data: {
          id: turn.id,
          tenantId: turn.tenantId,
          businessDate: toDate(turn.businessDate),
          number: turn.number,
          clientId: turn.clientId,
          clientName: turn.clientName,
          serviceIds: [...turn.serviceIds],
          preferredStylistId: turn.preferredStylistId,
          notes: turn.notes,
          createdAt: turn.createdAt,
          createdBy: turn.createdBy,
          ...this.toPersistence(turn),
        },
      }),
    );
    return this.toDomain(row);
  }

  async update(turn: QueueTurn, expected: QueueTurnStatusValue): Promise<QueueTurn> {
    let count: number;
    try {
      ({ count } = await this.prisma.client.queueTurn.updateMany({
        where: { id: turn.id, status: expected },
        data: this.toPersistence(turn),
      }));
    } catch (error) {
      // La única unicidad que un cambio de estado puede romper es «una clienta activa por
      // profesional» (índice parcial; Prisma no da su nombre, solo el código).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(
          'QUEUE_STYLIST_BUSY',
          'Esa profesional ya tiene a otra clienta llamada o en el sillón',
          { turnId: turn.id, stylistId: turn.stylistId },
        );
      }
      throw mapPrismaError(error, ENTITY);
    }

    if (count === 0) {
      throw new ConflictError(
        'QUEUE_TURN_CHANGED',
        'Este turno acaba de cambiar: otra persona lo llamó o lo cerró. Actualice la fila.',
        { turnId: turn.id },
      );
    }
    return this.findByIdOrFail(turn.id);
  }

  /** Lo que puede cambiar tras anotarla. Número, día, clienta y lo que pidió son fijos. */
  private toPersistence(turn: QueueTurn) {
    return {
      stylistId: turn.stylistId,
      status: turn.status,
      callCount: turn.callCount,
      calledAt: turn.calledAt,
      startedAt: turn.startedAt,
      closedAt: turn.closedAt,
      serviceTicketId: turn.serviceTicketId,
      cancellationReason: turn.cancellationReason,
      updatedAt: turn.updatedAt,
      updatedBy: turn.updatedBy,
    };
  }

  private toDomain(row: Row): QueueTurn {
    return QueueTurn.rehydrate(row.id, {
      tenantId: row.tenantId,
      businessDate: fromDate(row.businessDate),
      number: row.number,
      clientId: row.clientId,
      clientName: row.clientName,
      serviceIds: row.serviceIds,
      preferredStylistId: row.preferredStylistId,
      stylistId: row.stylistId,
      status: row.status,
      notes: row.notes,
      callCount: row.callCount,
      calledAt: row.calledAt,
      startedAt: row.startedAt,
      closedAt: row.closedAt,
      serviceTicketId: row.serviceTicketId,
      cancellationReason: row.cancellationReason,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    });
  }
}

/**
 * Enlace de la pantalla, guardado como hash en el propio salón.
 *
 * `Tenant` no tiene ámbito de salón (es la raíz del aislamiento), así que cada consulta
 * nombra el salón explícitamente.
 */
@Injectable()
export class PrismaQueueDisplayLinks implements QueueDisplayLinks {
  constructor(private readonly prisma: PrismaService) {}

  async replace(tenantId: string, tokenDigest: string): Promise<void> {
    await withMappedErrors('Salón', () =>
      this.prisma.client.tenant.update({
        where: { id: tenantId },
        data: { queueDisplayTokenHash: tokenDigest },
      }),
    );
  }

  async isActive(tenantId: string): Promise<boolean> {
    const row = await withMappedErrors('Salón', () =>
      this.prisma.client.tenant.findFirst({
        where: { id: tenantId },
        select: { queueDisplayTokenHash: true },
      }),
    );
    return !!row?.queueDisplayTokenHash;
  }

  async findSalonByDigest(tokenDigest: string): Promise<QueueDisplaySalon | null> {
    const row = await withMappedErrors('Salón', () =>
      this.prisma.client.tenant.findFirst({
        // Un salón suspendido o dado de baja no enseña su fila, tenga el enlace que tenga.
        where: { queueDisplayTokenHash: tokenDigest, status: { in: ['ACTIVE', 'TRIAL'] } },
        select: { id: true, name: true },
      }),
    );
    return row ? { tenantId: row.id, name: row.name } : null;
  }
}
