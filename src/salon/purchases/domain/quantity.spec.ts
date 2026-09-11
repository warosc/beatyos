import { DomainValidationError } from '../../../shared/domain/errors';
import { Quantity } from './quantity.vo';

const q = (value: string | number) => Quantity.fromDecimal(value);

describe('Cantidad de compra', () => {
  describe('aritmética exacta sobre la rejilla de milésimas', () => {
    /**
     * Este es el test que justifica que el value object exista. Con `number`,
     * `0,3 − 0,1` da `0,19999999999999998`, y comparar esa cifra con los `0,2` que
     * alguien intentaba recibir rechazaba una recepción legítima.
     */
    it('resta 0,1 de 0,3 y da exactamente 0,2', () => {
      const pendiente = q(0.3).subtract(q(0.1));
      expect(pendiente.equals(q(0.2))).toBe(true);
      expect(pendiente.toDecimalString()).toBe('0.200');
    });

    it('no deja resto al restar una cantidad de sí misma', () => {
      expect(q(1.333).subtract(q(1.333)).isZero()).toBe(true);
    });

    it('suma entregas sucesivas sin acumular deriva', () => {
      const total = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1].reduce(
        (acc, value) => acc.add(q(value)),
        Quantity.zero(),
      );
      expect(total.equals(q(0.7))).toBe(true);
    });

    it('compara sin ambigüedad lo pendiente con lo que se intenta recibir', () => {
      expect(q(0.2).greaterThan(q(0.3).subtract(q(0.1)))).toBe(false);
      expect(q(0.201).greaterThan(q(0.3).subtract(q(0.1)))).toBe(true);
    });
  });

  describe('precisión declarada por el esquema', () => {
    it('admite los tres decimales de Decimal(12,3)', () => {
      expect(q('1.234').toDecimalString()).toBe('1.234');
    });

    it('rechaza más precisión en vez de redondearla en silencio', () => {
      expect(() => q('0.0005')).toThrow(DomainValidationError);
    });

    it('acepta ceros de relleno porque no añaden precisión', () => {
      expect(q('2.500').equals(q(2.5))).toBe(true);
    });

    it('rechaza un valor que no es un decimal', () => {
      expect(() => q('mucho')).toThrow(DomainValidationError);
      expect(() => q(Number.POSITIVE_INFINITY)).toThrow(DomainValidationError);
    });
  });

  describe('conversión hacia fuera', () => {
    it('entrega un número a la frontera con inventario', () => {
      expect(q('2.500').toNumber()).toBe(2.5);
    });

    it('escribe siempre tres decimales, que es como los guarda la base', () => {
      expect(q(3).toDecimalString()).toBe('3.000');
      expect(q(0.5).toDecimalString()).toBe('0.500');
    });

    it('conserva el signo', () => {
      expect(q(1).subtract(q(3)).toDecimalString()).toBe('-2.000');
      expect(q(1).subtract(q(3)).isNegative()).toBe(true);
    });
  });
});
