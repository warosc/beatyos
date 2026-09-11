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
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import {
  REPORTING_REPOSITORY,
  type ReportingRepository,
} from '../../reports/domain/reporting.repository';
import { Goal, type GoalMetricValue } from '../domain/goal.entity';
import {
  GOAL_REPOSITORY,
  type GoalFilter,
  type GoalRepository,
  type GoalSortField,
} from '../domain/goal.repository';

// ===========================================================================
// Crear una meta
// ===========================================================================

export interface CreateGoalInput {
  readonly tenantId: string;
  readonly stylistId: string;
  readonly metric: GoalMetricValue;
  readonly targetAmount: string;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly rewardDescription: string;
  readonly actorId: string;
}

@Injectable()
export class CreateGoalUseCase implements UseCase<CreateGoalInput, GoalWithProgress> {
  constructor(
    @Inject(GOAL_REPOSITORY) private readonly goals: GoalRepository,
    @Inject(REPORTING_REPOSITORY) private readonly reporting: ReportingRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CreateGoalInput): Promise<GoalWithProgress> {
    const now = this.clock.now();

    const goal = Goal.define({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      stylistId: input.stylistId,
      metric: input.metric,
      targetAmount: Money.fromDecimal(input.targetAmount, input.currency),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      rewardDescription: input.rewardDescription,
      now,
      actorId: input.actorId,
    });

    const saved = await this.goals.create(goal);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Goal',
      entityId: saved.id,
      after: {
        stylistId: saved.stylistId,
        metric: saved.metric,
        targetAmount: saved.targetAmount.toDecimalString(),
        rewardDescription: saved.rewardDescription,
      },
    });

    // El periodo puede empezar en el pasado: la meta puede nacer con progreso ya hecho.
    return withProgress(saved, this.reporting, this.goals, now);
  }
}

// ===========================================================================
// Consultar metas, con el progreso ya resuelto
// ===========================================================================

export interface GoalWithProgress {
  readonly goal: Goal;
  readonly progress: Money;
  readonly percentage: number;
}

export interface SearchGoalsInput {
  readonly filter: GoalFilter;
  readonly page: PageRequest<GoalSortField>;
  /** Ámbito `goals.read.own`: limita el listado a las metas de este profesional. */
  readonly restrictToStylistId?: string | null;
}

/**
 * Resuelve el progreso de cada meta al vuelo, sumando las líneas de venta de su periodo —
 * igual que el resto de indicadores de la app (ADR-0015): no hay un contador que
 * mantener sincronizado, y una venta anulada deja de contar sin que nadie tenga que
 * corregir nada a mano.
 *
 * La primera vez que el progreso alcanza el objetivo, se marca `achievedAt` y se persiste:
 * a partir de ahí la meta queda cumplida aunque una anulación posterior baje la cifra.
 */
@Injectable()
export class SearchGoalsWithProgressUseCase implements UseCase<
  SearchGoalsInput,
  Page<GoalWithProgress>
> {
  constructor(
    @Inject(GOAL_REPOSITORY) private readonly goals: GoalRepository,
    @Inject(REPORTING_REPOSITORY) private readonly reporting: ReportingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: SearchGoalsInput): Promise<Page<GoalWithProgress>> {
    // El filtro por profesional se impone por encima del que envíe quien llama: con
    // `goals.read.own` no se amplía el alcance mandando el `stylistId` de otra persona.
    const filter: GoalFilter = input.restrictToStylistId
      ? { ...input.filter, stylistId: input.restrictToStylistId }
      : input.filter;

    const page = await this.goals.search(filter, input.page);
    const now = this.clock.now();

    const data = await Promise.all(
      page.data.map((goal) => withProgress(goal, this.reporting, this.goals, now)),
    );

    return { data, meta: page.meta };
  }
}

/**
 * Calcula el progreso de una meta sumando las líneas de venta de su periodo, y marca
 * `achievedAt` la primera vez que lo alcanza. Compartida entre crear y listar: una meta
 * recién creada puede empezar con progreso ya hecho si su periodo arranca en el pasado.
 */
async function withProgress(
  goal: Goal,
  reporting: ReportingRepository,
  goals: GoalRepository,
  now: Date,
): Promise<GoalWithProgress> {
  const currency = goal.targetAmount.currency;
  const kind = goal.metric === 'SERVICE_REVENUE' ? 'SERVICE' : 'PRODUCT';

  const lines = await reporting.findSaleLines({
    from: goal.periodStart,
    to: goal.periodEnd,
  });

  const progress = Money.sum(
    lines
      .filter((line) => line.stylistId === goal.stylistId && line.kind === kind)
      .map((line) => line.lineSubtotal),
    currency,
  );

  if (progress.greaterThanOrEqual(goal.targetAmount) && !goal.isAchieved) {
    goal.markAchieved(now);
    await goals.update(goal);
  }

  const percentage = goal.targetAmount.isZero()
    ? 0
    : Math.min(100, Math.round((progress.minorUnits / goal.targetAmount.minorUnits) * 100));

  return { goal, progress, percentage };
}

// ===========================================================================
// Cancelar una meta
// ===========================================================================

export interface DeleteGoalInput {
  readonly goalId: string;
  readonly actorId: string;
}

@Injectable()
export class DeleteGoalUseCase implements UseCase<DeleteGoalInput, void> {
  constructor(
    @Inject(GOAL_REPOSITORY) private readonly goals: GoalRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: DeleteGoalInput): Promise<void> {
    const goal = await this.goals.findByIdOrFail(input.goalId);
    goal.markDeleted(this.clock.now(), input.actorId);
    await this.goals.update(goal);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'Goal',
      entityId: goal.id,
      after: { deletedBy: input.actorId },
    });
  }
}
