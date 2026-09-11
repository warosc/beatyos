import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Goal, GoalMetricValue } from './goal.entity';

export interface GoalFilter {
  readonly stylistId?: string;
  readonly metric?: GoalMetricValue;
}

export type GoalSortField = 'periodStart' | 'createdAt';

export interface GoalRepository extends SearchableRepository<Goal, GoalFilter, GoalSortField> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Goal>;

  search(
    filter: GoalFilter,
    page: PageRequest<GoalSortField>,
    options?: QueryOptions,
  ): Promise<Page<Goal>>;

  create(goal: Goal): Promise<Goal>;
  /** Solo persiste `achievedAt` y el estado de baja: la meta en sí no se edita. */
  update(goal: Goal): Promise<Goal>;
}

export const GOAL_REPOSITORY = Symbol('GoalRepository');
