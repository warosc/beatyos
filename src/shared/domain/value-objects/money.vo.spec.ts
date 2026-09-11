import { DomainValidationError } from '../errors';
import { Money } from './money.vo';

describe('Money', () => {
  describe('construcción', () => {
    it('crea desde unidades menores', () => {
      const money = Money.fromMinorUnits(1250, 'EUR');
      expect(money.minorUnits).toBe(1250);
      expect(money.currency).toBe('EUR');
      expect(money.toDecimalString()).toBe('12.50');
    });

    it('crea desde cadena decimal', () => {
      expect(Money.fromDecimal('12.50', 'EUR').minorUnits).toBe(1250);
      expect(Money.fromDecimal('0.01', 'EUR').minorUnits).toBe(1);
      expect(Money.fromDecimal('1000', 'EUR').minorUnits).toBe(100_000);
      expect(Money.fromDecimal('-7.35', 'EUR').minorUnits).toBe(-735);
    });

    it('normaliza el código de moneda a mayúsculas', () => {
      expect(Money.fromDecimal('1.00', 'eur').currency).toBe('EUR');
      expect(Money.fromDecimal('1.00', ' usd ').currency).toBe('USD');
    });

    it('respeta el exponente de monedas sin subunidad', () => {
      const yen = Money.fromDecimal('1500', 'JPY');
      expect(yen.minorUnits).toBe(1500);
      expect(yen.toDecimalString()).toBe('1500');
    });

    it('rechaza una moneda que no sea ISO-4217 de tres letras', () => {
      expect(() => Money.fromDecimal('1.00', 'EUROS')).toThrow(DomainValidationError);
      expect(() => Money.fromDecimal('1.00', '')).toThrow(DomainValidationError);
      expect(() => Money.fromDecimal('1.00', '12')).toThrow(DomainValidationError);
    });

    it('rechaza decimales no representables en vez de redondearlos en silencio', () => {
      // Este es el caso que justifica el value object: aceptar 12.999 y guardarlo como
      // 13.00 introduce una diferencia que nadie ha autorizado.
      expect(() => Money.fromDecimal('12.999', 'EUR')).toThrow(DomainValidationError);
    });

    it('admite ceros no significativos de más', () => {
      expect(Money.fromDecimal('12.5000', 'EUR').minorUnits).toBe(1250);
    });

    it('rechaza cadenas que no son decimales', () => {
      expect(() => Money.fromDecimal('doce euros', 'EUR')).toThrow(DomainValidationError);
      expect(() => Money.fromDecimal('12,50', 'EUR')).toThrow(DomainValidationError);
      expect(() => Money.fromDecimal('', 'EUR')).toThrow(DomainValidationError);
    });

    it('rechaza unidades menores fraccionarias', () => {
      expect(() => Money.fromMinorUnits(12.5, 'EUR')).toThrow(DomainValidationError);
    });

    it('rechaza importes fuera del rango entero seguro', () => {
      expect(() => Money.fromMinorUnits(Number.MAX_SAFE_INTEGER + 10, 'EUR')).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('aritmética', () => {
    it('suma y resta sin error de coma flotante', () => {
      // El caso canónico: 0.1 + 0.2 en IEEE-754 da 0.30000000000000004.
      const total = Money.fromDecimal('0.10', 'EUR').add(Money.fromDecimal('0.20', 'EUR'));
      expect(total.toDecimalString()).toBe('0.30');
      expect(total.minorUnits).toBe(30);
    });

    it('acumula 0,01 cien veces y da exactamente 1,00', () => {
      let acc = Money.zero('EUR');
      for (let i = 0; i < 100; i += 1) acc = acc.add(Money.fromDecimal('0.01', 'EUR'));
      expect(acc.toDecimalString()).toBe('1.00');
    });

    it('multiplica por cantidades fraccionarias con redondeo half-up', () => {
      expect(Money.fromDecimal('10.00', 'EUR').multiply(2.5).toDecimalString()).toBe('25.00');
      expect(Money.fromDecimal('0.05', 'EUR').multiply(1.5).toDecimalString()).toBe('0.08');
    });

    it('redondea half-up de forma simétrica en negativos', () => {
      // Math.round(-2.5) es -2 y rompería la simetría: un abono dejaría de ser el
      // negativo exacto del cargo que compensa.
      const charge = Money.fromMinorUnits(5, 'EUR').multiply(0.5);
      const credit = Money.fromMinorUnits(-5, 'EUR').multiply(0.5);
      expect(charge.minorUnits).toBe(3);
      expect(credit.minorUnits).toBe(-3);
      expect(charge.add(credit).isZero()).toBe(true);
    });

    it('calcula porcentajes', () => {
      expect(Money.fromDecimal('100.00', 'EUR').percentage(21).toDecimalString()).toBe('21.00');
      expect(Money.fromDecimal('45.50', 'EUR').percentage(21).toDecimalString()).toBe('9.56');
      expect(Money.fromDecimal('100.00', 'EUR').percentage(0).isZero()).toBe(true);
    });

    it('niega y toma valor absoluto', () => {
      const amount = Money.fromDecimal('12.50', 'EUR');
      expect(amount.negate().toDecimalString()).toBe('-12.50');
      expect(amount.negate().absolute().toDecimalString()).toBe('12.50');
    });

    it('suma una colección', () => {
      const total = Money.sum(
        [Money.fromDecimal('10.00', 'EUR'), Money.fromDecimal('5.25', 'EUR')],
        'EUR',
      );
      expect(total.toDecimalString()).toBe('15.25');
    });

    it('suma de colección vacía es cero', () => {
      expect(Money.sum([], 'EUR').isZero()).toBe(true);
    });

    it('rechaza operar entre monedas distintas', () => {
      const euros = Money.fromDecimal('10.00', 'EUR');
      const dollars = Money.fromDecimal('10.00', 'USD');
      expect(() => euros.add(dollars)).toThrow(DomainValidationError);
      expect(() => euros.subtract(dollars)).toThrow(/monedas distintas/);
      expect(() => euros.greaterThan(dollars)).toThrow(DomainValidationError);
    });

    it('rechaza factores no finitos', () => {
      expect(() => Money.fromDecimal('1.00', 'EUR').multiply(Number.NaN)).toThrow(
        DomainValidationError,
      );
      expect(() => Money.fromDecimal('1.00', 'EUR').percentage(Number.POSITIVE_INFINITY)).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('allocate', () => {
    it('reparte sin perder ni inventar un céntimo', () => {
      const parts = Money.fromDecimal('100.00', 'EUR').allocate([1, 1, 1]);
      expect(parts.map((p) => p.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
      expect(Money.sum(parts, 'EUR').toDecimalString()).toBe('100.00');
    });

    it('reparte proporcionalmente a los pesos', () => {
      const parts = Money.fromDecimal('50.00', 'EUR').allocate([3, 1]);
      expect(parts.map((p) => p.toDecimalString())).toEqual(['37.50', '12.50']);
    });

    it('conserva el total con pesos irregulares', () => {
      const total = Money.fromDecimal('999.99', 'EUR');
      const parts = total.allocate([7, 11, 13, 2]);
      expect(Money.sum(parts, 'EUR').equals(total)).toBe(true);
    });

    it('reparte importes negativos conservando el total', () => {
      const total = Money.fromDecimal('-100.00', 'EUR');
      const parts = total.allocate([1, 1, 1]);
      expect(Money.sum(parts, 'EUR').toDecimalString()).toBe('-100.00');
    });

    it('es determinista ante pesos idénticos', () => {
      const first = Money.fromDecimal('10.00', 'EUR').allocate([1, 1, 1]);
      const second = Money.fromDecimal('10.00', 'EUR').allocate([1, 1, 1]);
      expect(first.map(String)).toEqual(second.map(String));
    });

    it('rechaza repartos imposibles', () => {
      const amount = Money.fromDecimal('10.00', 'EUR');
      expect(() => amount.allocate([])).toThrow(DomainValidationError);
      expect(() => amount.allocate([0, 0])).toThrow(/no puede ser cero/);
      expect(() => amount.allocate([-1, 2])).toThrow(DomainValidationError);
    });
  });

  describe('comparación e igualdad', () => {
    it('compara por contenido, no por identidad', () => {
      expect(Money.fromDecimal('10.00', 'EUR').equals(Money.fromMinorUnits(1000, 'EUR'))).toBe(
        true,
      );
      expect(Money.fromDecimal('10.00', 'EUR').equals(Money.fromDecimal('10.00', 'USD'))).toBe(
        false,
      );
      expect(Money.fromDecimal('10.00', 'EUR').equals(null)).toBe(false);
    });

    it('expone predicados de signo', () => {
      expect(Money.zero('EUR').isZero()).toBe(true);
      expect(Money.fromDecimal('1.00', 'EUR').isPositive()).toBe(true);
      expect(Money.fromDecimal('-1.00', 'EUR').isNegative()).toBe(true);
    });

    it('ordena importes', () => {
      const ten = Money.fromDecimal('10.00', 'EUR');
      const five = Money.fromDecimal('5.00', 'EUR');
      expect(ten.greaterThan(five)).toBe(true);
      expect(five.lessThan(ten)).toBe(true);
      expect(ten.greaterThanOrEqual(ten)).toBe(true);
    });
  });

  describe('serialización', () => {
    it('serializa como cadena decimal, nunca como número', () => {
      const json = Money.fromDecimal('1250.00', 'EUR').toJSON();
      expect(json).toEqual({ amount: '1250.00', currency: 'EUR' });
      expect(typeof json.amount).toBe('string');
    });

    it('mantiene los decimales en importes menores que uno', () => {
      expect(Money.fromMinorUnits(5, 'EUR').toDecimalString()).toBe('0.05');
      expect(Money.fromMinorUnits(0, 'EUR').toDecimalString()).toBe('0.00');
      expect(Money.fromMinorUnits(-5, 'EUR').toDecimalString()).toBe('-0.05');
    });

    it('sobrevive a un viaje de ida y vuelta por JSON', () => {
      const original = Money.fromDecimal('1234.56', 'EUR');
      const revived = Money.fromDecimal(JSON.parse(JSON.stringify(original)).amount, 'EUR');
      expect(revived.equals(original)).toBe(true);
    });

    it('formatea para presentación según locale', () => {
      const formatted = Money.fromDecimal('1234.56', 'EUR').format('es-ES');
      expect(formatted).toContain('1234');
      expect(formatted).toContain('€');
    });

    it('tiene representación legible', () => {
      expect(Money.fromDecimal('9.99', 'EUR').toString()).toBe('9.99 EUR');
    });
  });

  describe('inmutabilidad', () => {
    it('las operaciones devuelven instancias nuevas', () => {
      const original = Money.fromDecimal('10.00', 'EUR');
      const result = original.add(Money.fromDecimal('5.00', 'EUR'));
      expect(original.toDecimalString()).toBe('10.00');
      expect(result).not.toBe(original);
    });
  });
});
