import { Inject, Injectable } from '@nestjs/common';
import type { Goal as GoalRow } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import { Goal } from '../../domain/goal.entity';
import type { GoalFilter, GoalRepository, GoalSortField } from '../../domain/goal.repository';

@Injectable()
export class PrismaGoalRepository
  extends PrismaRepositoryBase<Goal, GoalRow, GoalFilter, GoalSortField>
  implements GoalRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'goal';
  protected readonly entityName = 'Meta';

  protected readonly sortableFields: ReadonlyMap<GoalSortField, OrderByClause | OrderByClause[]> =
    new Map<GoalSortField, OrderByClause | OrderByClause[]>([
      ['periodStart', { periodStart: true }],
      ['createdAt', { createdAt: true }],
    ]);

  protected readonly defaultSort = [{ field: 'periodStart' as const, direction: 'desc' as const }];

  async create(goal: Goal): Promise<Goal> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.goal.create({
        data: {
          id: goal.id,
          tenantId: goal.tenantId,
          stylistId: goal.stylistId,
          ...this.toPersistence(goal),
          createdAt: goal.audit.createdAt,
          createdBy: goal.audit.createdBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  async update(goal: Goal): Promise<Goal> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.goal.updateMany({
        where: { id: goal.id },
        data: {
          ...this.toPersistence(goal),
          updatedAt: goal.audit.updatedAt,
          updatedBy: goal.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, goal.id);
    }

    return this.findByIdOrFail(goal.id, { includeDeleted: goal.audit.deletedAt !== null });
  }

  async save(goal: Goal): Promise<Goal> {
    return this.update(goal);
  }

  protected buildWhere(filter: GoalFilter): Record<string, unknown> {
    return this.compose(
      filter.stylistId ? { stylistId: filter.stylistId } : undefined,
      filter.metric ? { metric: filter.metric } : undefined,
    );
  }

  private toPersistence(goal: Goal) {
    return {
      metric: goal.metric,
      targetAmount: goal.targetAmount.toDecimalString(),
      currency: goal.targetAmount.currency,
      periodStart: goal.periodStart,
      periodEnd: goal.periodEnd,
      rewardDescription: goal.rewardDescription,
      achievedAt: goal.achievedAt,
      deletedAt: goal.audit.deletedAt,
      deletedBy: goal.audit.deletedBy,
    };
  }

  protected toDomain(row: GoalRow): Goal {
    return Goal.rehydrate(row.id, {
      tenantId: row.tenantId,
      stylistId: row.stylistId,
      metric: row.metric,
      targetAmount: Money.fromDecimal(row.targetAmount.toFixed(2), row.currency),
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      rewardDescription: row.rewardDescription,
      achievedAt: row.achievedAt,
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
}
