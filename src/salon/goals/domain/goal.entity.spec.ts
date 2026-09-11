import { DomainValidationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Goal } from './goal.entity';

const TENANT = '11111111-1111-7111-8111-111111111111';
const STYLIST = '22222222-2222-7222-8222-222222222222';
const NOW = new Date('2026-09-08T10:00:00.000Z');
const PERIOD_START = new Date('2026-09-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-09-30T23:59:59.000Z');

const aGoal = (overrides: Partial<Parameters<typeof Goal.define>[0]> = {}) =>
  Goal.define({
    id: 'goal-1',
    tenantId: TENANT,
    stylistId: STYLIST,
    metric: 'PRODUCT_REVENUE',
    targetAmount: Money.fromDecimal('2000.00', 'GTQ'),
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    rewardDescription: 'Gift card Q200 Walmart',
    now: NOW,
    actorId: 'user-1',
    ...overrides,
  });

describe('Goal', () => {
  describe('definición', () => {
    it('define la meta con lo indicado', () => {
      const goal = aGoal();

      expect(goal.metric).toBe('PRODUCT_REVENUE');
      expect(goal.targetAmount.toDecimalString()).toBe('2000.00');
      expect(goal.rewardDescription).toBe('Gift card Q200 Walmart');
      expect(goal.isAchieved).toBe(false);
      expect(goal.achievedAt).toBeNull();
    });

    it('recorta espacios en la descripción de la recompensa', () => {
      expect(aGoal({ rewardDescription: '  Gift card  ' }).rewardDescription).toBe('Gift card');
    });

    it('rechaza un objetivo de cero', () => {
      expect(() => aGoal({ targetAmount: Money.zero('GTQ') })).toThrow(DomainValidationError);
    });

    it('rechaza un objetivo negativo', () => {
      expect(() => aGoal({ targetAmount: Money.fromDecimal('-10.00', 'GTQ') })).toThrow(
        DomainValidationError,
      );
    });

    it('rechaza un periodo cuyo fin no es posterior al inicio', () => {
      expect(() => aGoal({ periodStart: PERIOD_END, periodEnd: PERIOD_START })).toThrow(
        DomainValidationError,
      );
      expect(() => aGoal({ periodStart: PERIOD_START, periodEnd: PERIOD_START })).toThrow(
        DomainValidationError,
      );
    });

    it('rechaza una recompensa vacía', () => {
      expect(() => aGoal({ rewardDescription: '   ' })).toThrow(DomainValidationError);
    });
  });

  describe('cumplimiento', () => {
    it('se marca cumplida y queda fijada la fecha', () => {
      const goal = aGoal();
      const achievedAt = new Date('2026-09-20T15:00:00.000Z');

      goal.markAchieved(achievedAt);

      expect(goal.isAchieved).toBe(true);
      expect(goal.achievedAt).toEqual(achievedAt);
    });

    it('es idempotente: una segunda llamada no mueve la fecha ya fijada', () => {
      const goal = aGoal();
      const firstAchievement = new Date('2026-09-20T15:00:00.000Z');
      const later = new Date('2026-09-25T09:00:00.000Z');

      goal.markAchieved(firstAchievement);
      goal.markAchieved(later);

      expect(goal.achievedAt).toEqual(firstAchievement);
    });
  });

  describe('estado para mostrar', () => {
    it('está activa dentro del periodo, sin cumplirse', () => {
      const goal = aGoal();
      expect(goal.statusAt(new Date('2026-09-15T00:00:00.000Z'))).toBe('ACTIVE');
    });

    it('expira al pasar el fin del periodo sin cumplirse', () => {
      const goal = aGoal();
      expect(goal.statusAt(new Date('2026-10-01T00:00:00.000Z'))).toBe('EXPIRED');
    });

    it('una vez cumplida, se queda cumplida aunque ya haya pasado el periodo', () => {
      const goal = aGoal();
      goal.markAchieved(new Date('2026-09-20T00:00:00.000Z'));

      expect(goal.statusAt(new Date('2026-10-15T00:00:00.000Z'))).toBe('ACHIEVED');
    });
  });

  describe('baja', () => {
    it('marca la meta como eliminada', () => {
      const goal = aGoal();
      const deletedAt = new Date('2026-09-10T00:00:00.000Z');

      goal.markDeleted(deletedAt, 'user-2');

      expect(goal.audit.deletedAt).toEqual(deletedAt);
      expect(goal.audit.deletedBy).toBe('user-2');
    });
  });
});
