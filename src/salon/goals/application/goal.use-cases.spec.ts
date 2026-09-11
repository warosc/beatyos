import type { AuditRecorder, Clock, IdGenerator } from '../../../shared/application/ports';
import { buildPage } from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import type { ReportingRepository } from '../../reports/domain/reporting.repository';
import type { SaleLineFact } from '../../reports/domain/reporting';
import { Goal } from '../domain/goal.entity';
import type { GoalFilter, GoalRepository } from '../domain/goal.repository';
import {
  CreateGoalUseCase,
  DeleteGoalUseCase,
  SearchGoalsWithProgressUseCase,
} from './goal.use-cases';

const NOW = new Date('2037-09-15T12:00:00.000Z');
const START = new Date('2037-09-01T00:00:00.000Z');
const END = new Date('2037-09-30T23:59:59.000Z');
const PAGE = { page: 1, limit: 20 } as const;

const goal = (metric: 'SERVICE_REVENUE' | 'PRODUCT_REVENUE' = 'PRODUCT_REVENUE') =>
  Goal.define({
    id: 'goal-1',
    tenantId: 'tenant-1',
    stylistId: 'stylist-1',
    metric,
    targetAmount: Money.fromDecimal('100.00', 'GTQ'),
    periodStart: START,
    periodEnd: END,
    rewardDescription: 'Bono',
    now: NOW,
    actorId: 'owner-1',
  });

const line = (
  kind: SaleLineFact['kind'],
  stylistId: string | null,
  amount: string,
): SaleLineFact => ({
  kind,
  stylistId,
  productId: kind === 'PRODUCT' ? 'product-1' : null,
  serviceId: kind === 'SERVICE' ? 'service-1' : null,
  stylistName: stylistId ? 'Ana' : null,
  description: 'Venta',
  quantity: 1,
  lineSubtotal: Money.fromDecimal(amount, 'GTQ'),
  lineTotal: Money.fromDecimal(amount, 'GTQ'),
  commissionAmount: Money.zero('GTQ'),
});

describe('Casos de uso de metas', () => {
  const clock: Clock = { now: () => NOW };
  const ids: IdGenerator = { generate: () => 'goal-1' };
  const audit: AuditRecorder = { record: jest.fn().mockResolvedValue(undefined) };
  let stored: Goal;
  let lastFilter: GoalFilter | undefined;
  let goals: GoalRepository;
  let reporting: ReportingRepository;

  beforeEach(() => {
    stored = goal();
    lastFilter = undefined;
    goals = {
      findById: jest.fn(async () => stored),
      findByIdOrFail: jest.fn(async () => stored),
      exists: jest.fn(async () => true),
      count: jest.fn(async () => 1),
      search: jest.fn(async (filter, page) => {
        lastFilter = filter;
        return buildPage([stored], 1, page);
      }),
      create: jest.fn(async (created) => {
        stored = created;
        return created;
      }),
      update: jest.fn(async (updated) => {
        stored = updated;
        return updated;
      }),
      save: jest.fn(async (saved) => saved),
      softDelete: jest.fn(async () => undefined),
      restore: jest.fn(async () => stored),
    };
    reporting = {
      findSaleLines: jest.fn(async () => []),
      findSales: jest.fn(async () => []),
      findAppointments: jest.fn(async () => []),
      findSchedules: jest.fn(async () => []),
      countProductsBelowReorderPoint: jest.fn(async () => 0),
      findUpcomingAppointments: jest.fn(async () => []),
    };
  });

  it('crea una meta y devuelve el progreso ya acumulado', async () => {
    jest
      .mocked(reporting.findSaleLines)
      .mockResolvedValue([
        line('PRODUCT', 'stylist-1', '60.00'),
        line('PRODUCT', 'stylist-1', '40.00'),
        line('SERVICE', 'stylist-1', '999.00'),
        line('PRODUCT', 'stylist-2', '999.00'),
      ]);
    const useCase = new CreateGoalUseCase(goals, reporting, ids, clock, audit);

    const result = await useCase.execute({
      tenantId: 'tenant-1',
      stylistId: 'stylist-1',
      metric: 'PRODUCT_REVENUE',
      targetAmount: '100.00',
      currency: 'GTQ',
      periodStart: START,
      periodEnd: END,
      rewardDescription: 'Bono',
      actorId: 'owner-1',
    });

    expect(result.progress.toDecimalString()).toBe('100.00');
    expect(result.percentage).toBe(100);
    expect(result.goal.isAchieved).toBe(true);
    expect(goals.update).toHaveBeenCalledWith(result.goal);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE' }));
  });

  it('calcula servicios, limita el porcentaje y no vuelve a marcar una meta cumplida', async () => {
    stored = goal('SERVICE_REVENUE');
    stored.markAchieved(new Date('2037-09-10T10:00:00.000Z'));
    jest
      .mocked(reporting.findSaleLines)
      .mockResolvedValue([line('SERVICE', 'stylist-1', '150.00')]);
    const useCase = new SearchGoalsWithProgressUseCase(goals, reporting, clock);

    const result = await useCase.execute({ filter: {}, page: PAGE });

    expect(result.data[0].percentage).toBe(100);
    expect(goals.update).not.toHaveBeenCalled();
  });

  it('impone el profesional del alcance own y conserva un progreso parcial', async () => {
    jest.mocked(reporting.findSaleLines).mockResolvedValue([line('PRODUCT', 'stylist-1', '49.60')]);
    const useCase = new SearchGoalsWithProgressUseCase(goals, reporting, clock);

    const result = await useCase.execute({
      filter: { stylistId: 'stylist-ajeno' },
      page: PAGE,
      restrictToStylistId: 'stylist-1',
    });

    expect(lastFilter).toEqual({ stylistId: 'stylist-1' });
    expect(result.data[0].percentage).toBe(50);
    expect(result.data[0].goal.isAchieved).toBe(false);
  });

  it('marca la meta como eliminada y registra la auditoría', async () => {
    const useCase = new DeleteGoalUseCase(goals, clock, audit);

    await useCase.execute({ goalId: stored.id, actorId: 'owner-1' });

    expect(stored.audit.deletedAt).toEqual(NOW);
    expect(goals.update).toHaveBeenCalledWith(stored);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE' }));
  });
});
