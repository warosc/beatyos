import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type CashMovement as MovementRow } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { ConflictError, EntityNotFoundError } from '../../../../shared/domain/errors';
import type { QueryOptions } from '../../../../shared/domain/ports/repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { CashSession, type CashMovement } from '../../domain/cash-session.entity';
import type {
  CashSessionFilter,
  CashSessionRepository,
  CashSessionSortField,
} from '../../domain/cash.repositories';

const SESSION_INCLUDE = {
  movements: { where: { deletedAt: null }, orderBy: { occurredAt: 'asc' as const } },
} satisfies Prisma.CashSessionInclude;

type SessionWithMovements = Prisma.CashSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

@Injectable()
export class PrismaCashSessionRepository
  extends PrismaRepositoryBase<
    CashSession,
    SessionWithMovements,
    CashSessionFilter,
    CashSessionSortField
  >
  implements CashSessionRepository
{
  private readonly currency: string;

  constructor(
    prisma: PrismaService,
    @Inject(CLOCK) clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    super(prisma, clock);
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  protected readonly delegateName = 'cashSession';
  protected readonly entityName = 'Caja';

  protected readonly sortableFields: ReadonlyMap<
    CashSessionSortField,
    OrderByClause | OrderByClause[]
  > = new Map<CashSessionSortField, OrderByClause | OrderByClause[]>([
    ['openedAt', { openedAt: true }],
    ['closedAt', { closedAt: true }],
    ['difference', { difference: true }],
  ]);

  protected readonly defaultSort = [{ field: 'openedAt' as const, direction: 'desc' as const }];

  override async findById(id: string, options?: QueryOptions): Promise<CashSession | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.cashSession.findFirst({ where: { id }, include: SESSION_INCLUDE }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findOpen(): Promise<CashSession | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.cashSession.findFirst({
        where: { status: 'OPEN' },
        include: SESSION_INCLUDE,
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  override async search(
    filter: CashSessionFilter,
    page: Parameters<CashSessionRepository['search']>[1],
    options?: QueryOptions,
  ) {
    const where = this.buildWhere(filter);

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.prisma.client.cashSession.count({ where }),
          this.prisma.client.cashSession.findMany({
            where,
            orderBy: this.buildOrderBy(page.sort),
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: SESSION_INCLUDE,
          }),
        ]),
      ),
    );

    return {
      data: rows.map((row) => this.toDomain(row)),
      meta: {
        page: page.page,
        limit: page.limit,
        total,
        totalPages: page.limit > 0 ? Math.ceil(total / page.limit) : 0,
        hasNext: page.page * page.limit < total,
        hasPrevious: page.page > 1 && total > 0,
      },
    };
  }

  /**
   * Abre la caja apoyándose en el índice único parcial.
   *
   * `cash_sessions_one_open_per_tenant` es un índice único sobre `tenantId` filtrado por
   * `status = 'OPEN'`. La comprobación previa del caso de uso da el mensaje útil; **esta
   * restricción es la que impide de verdad** que dos peticiones simultáneas abran dos cajas
   * y repartan los cobros del día entre ambas de forma impredecible.
   *
   * Se traduce la violación a un conflicto con sentido: un `P2002` crudo diría «unique
   * constraint failed» y quien lo lea en el mostrador no sabría que basta con cerrar la caja
   * que ya estaba abierta.
   */
  async create(session: CashSession): Promise<CashSession> {
    try {
      const row = await this.prisma.client.cashSession.create({
        data: {
          id: session.id,
          tenantId: session.tenantId,
          openedById: session.openedById,
          status: session.status,
          openedAt: session.openedAt,
          openingFloat: session.openingFloat.toDecimalString(),
          currency: session.currency,
          notes: session.notes,
          createdAt: session.audit.createdAt,
          updatedAt: session.audit.updatedAt,
          createdBy: session.audit.createdBy,
          updatedBy: session.audit.updatedBy,
        },
        include: SESSION_INCLUDE,
      });
      return this.toDomain(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(
          'CASH_SESSION_ALREADY_OPEN',
          'Ya hay una caja abierta en este salón. Ciérrela antes de abrir otra.',
        );
      }
      throw error;
    }
  }

  /**
   * Guarda la sesión y **añade** los movimientos nuevos.
   *
   * Los movimientos no se reescriben en bloque como se hace con las líneas de un servicio:
   * son hechos de caja con hora, y borrarlos para volver a insertarlos cambiaría sus
   * identificadores y su `occurredAt` cada vez que alguien anote uno nuevo. Se insertan solo
   * los que no existen todavía.
   */
  async update(session: CashSession): Promise<CashSession> {
    return this.prisma.transaction(async () => {
      const result = await withMappedErrors(this.entityName, () =>
        this.prisma.client.cashSession.updateMany({
          where: { id: session.id },
          data: {
            status: session.status,
            closedAt: session.closedAt,
            closedById: session.closedById,
            countedAmount: session.countedAmount?.toDecimalString() ?? null,
            expectedAmount: session.settledExpectedAmount?.toDecimalString() ?? null,
            difference: session.difference?.toDecimalString() ?? null,
            notes: session.notes,
            updatedAt: session.audit.updatedAt,
            updatedBy: session.audit.updatedBy,
            deletedAt: session.audit.deletedAt,
            deletedBy: session.audit.deletedBy,
          },
        }),
      );

      if (result.count === 0) {
        throw new EntityNotFoundError(this.entityName, session.id);
      }

      const existingIds = new Set(
        (
          await this.prisma.client.cashMovement.findMany({
            where: { sessionId: session.id },
            select: { id: true },
          })
        ).map((row) => row.id),
      );

      const pending = session.movements.filter((movement) => !existingIds.has(movement.id));

      if (pending.length > 0) {
        // `tenantId` explícito: `createMany` no pasa por la extensión que lo inyecta.
        await this.prisma.client.cashMovement.createMany({
          data: pending.map((movement) => ({
            id: movement.id,
            tenantId: session.tenantId,
            sessionId: session.id,
            type: movement.type,
            amount: movement.amount.toDecimalString(),
            currency: session.currency,
            concept: movement.concept,
            reference: movement.reference,
            notes: movement.notes,
            occurredAt: movement.occurredAt,
            createdBy: movement.createdBy,
          })),
        });
      }

      return this.findByIdOrFail(session.id);
    });
  }

  async save(session: CashSession): Promise<CashSession> {
    return this.update(session);
  }

  protected buildWhere(filter: CashSessionFilter): Record<string, unknown> {
    return this.compose(
      filter.status ? { status: filter.status } : undefined,
      filter.openedById ? { openedById: filter.openedById } : undefined,
      this.dateRange(filter.from, filter.to)
        ? { openedAt: this.dateRange(filter.from, filter.to) }
        : undefined,
      // Un descuadre de cero no es un descuadre. `not: 0` lo excluye sin tener que
      // enumerar rangos positivos y negativos por separado.
      filter.onlyWithDifference ? { difference: { not: 0 } } : undefined,
    );
  }

  protected toDomain(row: SessionWithMovements): CashSession {
    const currency = row.currency || this.currency;

    return CashSession.rehydrate(row.id, {
      tenantId: row.tenantId,
      openedById: row.openedById,
      status: row.status,
      openedAt: row.openedAt,
      openingFloat: Money.fromDecimal(row.openingFloat.toFixed(2), currency),
      closedAt: row.closedAt,
      closedById: row.closedById,
      countedAmount:
        row.countedAmount === null
          ? null
          : Money.fromDecimal(row.countedAmount.toFixed(2), currency),
      expectedAmount:
        row.expectedAmount === null
          ? null
          : Money.fromDecimal(row.expectedAmount.toFixed(2), currency),
      difference:
        row.difference === null ? null : Money.fromDecimal(row.difference.toFixed(2), currency),
      currency,
      notes: row.notes,
      movements: row.movements.map((movement) => this.movementToDomain(movement, currency)),
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

  private movementToDomain(row: MovementRow, currency: string): CashMovement {
    return {
      id: row.id,
      type: row.type,
      amount: Money.fromDecimal(row.amount.toFixed(2), row.currency || currency),
      concept: row.concept,
      reference: row.reference,
      notes: row.notes,
      occurredAt: row.occurredAt,
      createdBy: row.createdBy,
    };
  }
}
