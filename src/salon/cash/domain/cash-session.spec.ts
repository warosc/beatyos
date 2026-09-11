import {
  BusinessRuleViolationError,
  DomainValidationError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { CashSession, type CashMovementTypeValue } from './cash-session.entity';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-09-03T10:00:00.000Z');
const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');

let sequence = 0;

const aSession = (openingFloat = '500.00') =>
  CashSession.open({
    id: 'session-1',
    tenantId: TENANT,
    openedById: 'user-1',
    openingFloat: gtq(openingFloat),
    now: NOW,
    actorId: 'user-1',
  });

const record = (
  session: CashSession,
  type: CashMovementTypeValue,
  amount: string,
  concept = 'Concepto',
) =>
  session.recordMovement({
    id: `movement-${(sequence += 1)}`,
    type,
    amount: gtq(amount),
    concept,
    now: NOW,
    actorId: 'user-1',
  });

beforeEach(() => {
  sequence = 0;
});

describe('CashSession', () => {
  describe('apertura', () => {
    it('nace abierta con su fondo', () => {
      const session = aSession('500.00');

      expect(session.isOpen).toBe(true);
      expect(session.openingFloat.toDecimalString()).toBe('500.00');
      expect(session.movements).toHaveLength(0);
    });

    it('rechaza un fondo negativo', () => {
      expect(() =>
        CashSession.open({
          id: 'session-2',
          tenantId: TENANT,
          openedById: 'user-1',
          openingFloat: gtq('-1.00'),
          now: NOW,
          actorId: 'user-1',
        }),
      ).toThrow(DomainValidationError);
    });

    it('toma la moneda del fondo', () => {
      expect(aSession().currency).toBe('GTQ');
    });
  });

  describe('movimientos', () => {
    it('suma las entradas y resta las salidas', () => {
      const session = aSession('500.00');
      record(session, 'CASH_IN', '100.00');
      record(session, 'CASH_OUT', '30.00');
      record(session, 'EXPENSE', '20.00');

      expect(session.netMovements.toDecimalString()).toBe('50.00');
    });

    it('trata la retirada como una salida', () => {
      const session = aSession('500.00');
      record(session, 'WITHDRAWAL', '200.00');

      expect(session.netMovements.toDecimalString()).toBe('-200.00');
    });

    it('admite corrección en los dos sentidos', () => {
      // Es el único tipo con signo: existe precisamente para cuadrar un descuadre conocido,
      // que puede ser de más o de menos.
      const session = aSession('500.00');
      record(session, 'CORRECTION', '-15.00');

      expect(session.netMovements.toDecimalString()).toBe('-15.00');
    });

    it('rechaza una entrada con importe negativo', () => {
      // Un `CASH_IN` negativo es una salida disfrazada: el informe la contaría como ingreso
      // y el arqueo cuadraría ocultando justo lo que debería destacar.
      const session = aSession('500.00');

      expect(() => record(session, 'CASH_IN', '-50.00')).toThrow(/el sentido lo da el tipo/);
    });

    it('rechaza un movimiento de cero', () => {
      expect(() => record(aSession(), 'CASH_IN', '0.00')).toThrow(DomainValidationError);
    });

    it('exige un concepto', () => {
      const session = aSession();

      expect(() => record(session, 'CASH_IN', '10.00', '   ')).toThrow(/concepto/);
    });

    it('impide sacar más de lo que hay en el cajón', () => {
      // O el importe está mal o falta registrar una entrada. En ambos casos hay que
      // pararlo, no anotarlo.
      const session = aSession('100.00');

      expect(() => record(session, 'WITHDRAWAL', '150.00')).toThrow(BusinessRuleViolationError);
      expect(session.movements).toHaveLength(0);
    });

    it('no admite movimientos con la caja cerrada', () => {
      const session = aSession();
      session.close({
        countedAmount: gtq('500.00'),
        cashSales: gtq('0.00'),
        now: NOW,
        actorId: 'u',
      });

      expect(() => record(session, 'CASH_IN', '10.00')).toThrow(InvalidStateTransitionError);
    });
  });

  describe('efectivo esperado', () => {
    it('suma fondo, cobros en efectivo y movimientos', () => {
      const session = aSession('500.00');
      record(session, 'CASH_IN', '50.00');
      record(session, 'EXPENSE', '20.00');

      expect(session.expectedAmount(gtq('300.00')).toDecimalString()).toBe('830.00');
    });

    it('rechaza cobros en otra moneda', () => {
      expect(() => aSession().expectedAmount(Money.fromDecimal('300.00', 'USD'))).toThrow(
        DomainValidationError,
      );
    });

    it('congela la cifra al cerrar', () => {
      // Recalcularla daría un número distinto si alguien anota algo después, y el arqueo
      // dejaría de ser un hecho histórico.
      const session = aSession('500.00');
      session.close({
        countedAmount: gtq('800.00'),
        cashSales: gtq('300.00'),
        now: NOW,
        actorId: 'u',
      });

      expect(session.expectedAmount(gtq('999.00')).toDecimalString()).toBe('800.00');
      expect(session.settledExpectedAmount?.toDecimalString()).toBe('800.00');
    });

    it('no expone cifra congelada mientras la caja siga abierta', () => {
      expect(aSession().settledExpectedAmount).toBeNull();
    });
  });

  describe('cierre', () => {
    it('registra la diferencia cuando falta dinero', () => {
      const session = aSession('500.00');
      session.close({
        countedAmount: gtq('780.00'),
        cashSales: gtq('300.00'),
        now: NOW,
        actorId: 'user-2',
      });

      expect(session.isOpen).toBe(false);
      expect(session.difference?.toDecimalString()).toBe('-20.00');
      expect(session.closedById).toBe('user-2');
    });

    it('registra la diferencia cuando sobra', () => {
      const session = aSession('500.00');
      session.close({
        countedAmount: gtq('815.50'),
        cashSales: gtq('300.00'),
        now: NOW,
        actorId: 'u',
      });

      expect(session.difference?.toDecimalString()).toBe('15.50');
    });

    it('no rechaza el descuadre', () => {
      // Una caja que solo se deja cerrar cuando cuadra acaba cuadrando siempre porque
      // alguien ajusta el recuento hasta que el sistema lo acepta, que es exactamente el
      // dato que se quería medir.
      const session = aSession('500.00');

      expect(() =>
        session.close({
          countedAmount: gtq('0.00'),
          cashSales: gtq('300.00'),
          now: NOW,
          actorId: 'u',
        }),
      ).not.toThrow();
      expect(session.difference?.toDecimalString()).toBe('-800.00');
    });

    it('cuadra exactamente cuando el recuento coincide', () => {
      const session = aSession('500.00');
      record(session, 'CASH_IN', '25.00');
      session.close({
        countedAmount: gtq('825.00'),
        cashSales: gtq('300.00'),
        now: NOW,
        actorId: 'u',
      });

      expect(session.difference?.isZero()).toBe(true);
    });

    it('rechaza un recuento negativo', () => {
      expect(() =>
        aSession().close({
          countedAmount: gtq('-1.00'),
          cashSales: gtq('0.00'),
          now: NOW,
          actorId: 'u',
        }),
      ).toThrow(DomainValidationError);
    });

    it('no cierra dos veces', () => {
      const session = aSession();
      session.close({
        countedAmount: gtq('500.00'),
        cashSales: gtq('0.00'),
        now: NOW,
        actorId: 'u',
      });

      expect(() =>
        session.close({
          countedAmount: gtq('500.00'),
          cashSales: gtq('0.00'),
          now: NOW,
          actorId: 'u',
        }),
      ).toThrow(InvalidStateTransitionError);
    });
  });
});
