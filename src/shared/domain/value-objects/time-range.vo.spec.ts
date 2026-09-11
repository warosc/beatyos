import { DomainValidationError } from '../errors';
import { Percentage, TimeRange } from './time-range.vo';

/**
 * `TimeRange` sostiene toda la agenda, y su semántica **semiabierta** es la razón de que
 * dos citas consecutivas no se consideren solapadas. Estos tests fijan esa semántica: si
 * alguien la cambiara a intervalos cerrados, el sistema empezaría a rechazar la reserva
 * más habitual de una peluquería y aquí saltaría de inmediato.
 */
describe('TimeRange', () => {
  const at = (hour: number, minute = 0): Date =>
    new Date(Date.UTC(2026, 8, 10, hour, minute, 0, 0));

  describe('construcción', () => {
    it('crea a partir de inicio y fin', () => {
      const range = TimeRange.create(at(10), at(11));
      expect(range.durationMinutes).toBe(60);
      expect(range.startsAt).toEqual(at(10));
      expect(range.endsAt).toEqual(at(11));
    });

    it('crea a partir de inicio y duración, que es como se agenda de verdad', () => {
      const range = TimeRange.fromDuration(at(10), 45);
      expect(range.endsAt).toEqual(at(10, 45));
    });

    it('rechaza un fin anterior o igual al inicio', () => {
      expect(() => TimeRange.create(at(11), at(10))).toThrow(DomainValidationError);
      expect(() => TimeRange.create(at(10), at(10))).toThrow(/posterior/);
    });

    it('rechaza fechas inválidas', () => {
      expect(() => TimeRange.create(new Date('no es fecha'), at(11))).toThrow(
        DomainValidationError,
      );
      expect(() => TimeRange.create(at(10), new Date('no es fecha'))).toThrow(
        DomainValidationError,
      );
    });

    it('rechaza duraciones no positivas o fraccionarias', () => {
      expect(() => TimeRange.fromDuration(at(10), 0)).toThrow(DomainValidationError);
      expect(() => TimeRange.fromDuration(at(10), -30)).toThrow(DomainValidationError);
      expect(() => TimeRange.fromDuration(at(10), 30.5)).toThrow(DomainValidationError);
    });
  });

  describe('solapamiento', () => {
    it('dos citas consecutivas NO se solapan', () => {
      const first = TimeRange.create(at(10), at(11));
      const second = TimeRange.create(at(11), at(12));

      // El caso más frecuente en una peluquería. Con intervalos cerrados, el sistema
      // rechazaría la segunda reserva y el usuario lo viviría como un error del programa.
      expect(first.overlaps(second)).toBe(false);
      expect(second.overlaps(first)).toBe(false);
    });

    it('detecta un solapamiento parcial en ambos sentidos', () => {
      const first = TimeRange.create(at(10), at(11));
      const second = TimeRange.create(at(10, 30), at(11, 30));

      expect(first.overlaps(second)).toBe(true);
      expect(second.overlaps(first)).toBe(true);
    });

    it('detecta un intervalo contenido en otro', () => {
      const outer = TimeRange.create(at(9), at(13));
      const inner = TimeRange.create(at(10), at(11));

      expect(outer.overlaps(inner)).toBe(true);
      expect(inner.overlaps(outer)).toBe(true);
    });

    it('no solapa con intervalos completamente separados', () => {
      expect(TimeRange.create(at(9), at(10)).overlaps(TimeRange.create(at(12), at(13)))).toBe(
        false,
      );
    });
  });

  describe('consultas', () => {
    it('contains incluye el inicio y excluye el fin', () => {
      const range = TimeRange.create(at(10), at(11));

      expect(range.contains(at(10))).toBe(true);
      expect(range.contains(at(10, 30))).toBe(true);
      // Coherente con el solapamiento: el instante final ya pertenece a la cita siguiente.
      expect(range.contains(at(11))).toBe(false);
    });

    it('isWithin comprueba la contención completa', () => {
      const shift = TimeRange.create(at(9), at(18));

      expect(TimeRange.create(at(10), at(11)).isWithin(shift)).toBe(true);
      expect(TimeRange.create(at(8), at(11)).isWithin(shift)).toBe(false);
      expect(TimeRange.create(at(17), at(19)).isWithin(shift)).toBe(false);
    });

    it('isBefore admite que se toquen por el extremo', () => {
      expect(TimeRange.create(at(9), at(10)).isBefore(TimeRange.create(at(10), at(11)))).toBe(true);
      expect(TimeRange.create(at(9), at(11)).isBefore(TimeRange.create(at(10), at(12)))).toBe(
        false,
      );
    });

    it('isInThePast usa el fin del intervalo', () => {
      const range = TimeRange.create(at(10), at(11));

      // Una cita en curso no es pasado: sigue ocupando el sillón.
      expect(range.isInThePast(at(10, 30))).toBe(false);
      expect(range.isInThePast(at(11))).toBe(true);
    });
  });

  describe('transformaciones', () => {
    it('shiftTo conserva la duración', () => {
      const moved = TimeRange.fromDuration(at(10), 45).shiftTo(at(15));

      // Es lo que ocurre al arrastrar una cita en el calendario: cambia la hora, no lo
      // que dura el servicio.
      expect(moved.startsAt).toEqual(at(15));
      expect(moved.durationMinutes).toBe(45);
    });

    it('withDuration conserva el inicio', () => {
      const resized = TimeRange.create(at(10), at(11)).withDuration(90);
      expect(resized.startsAt).toEqual(at(10));
      expect(resized.durationMinutes).toBe(90);
    });

    it('extendBy alarga por el final', () => {
      // El margen de limpieza bloquea agenda pero no se factura.
      const extended = TimeRange.create(at(10), at(11)).extendBy(15);
      expect(extended.endsAt).toEqual(at(11, 15));
    });

    it('extendBy rechaza minutos negativos', () => {
      expect(() => TimeRange.create(at(10), at(11)).extendBy(-10)).toThrow(DomainValidationError);
    });

    it('las transformaciones devuelven instancias nuevas', () => {
      const original = TimeRange.create(at(10), at(11));
      const extended = original.extendBy(15);

      expect(original.endsAt).toEqual(at(11));
      expect(extended).not.toBe(original);
    });
  });

  describe('igualdad y serialización', () => {
    it('compara por contenido', () => {
      expect(TimeRange.create(at(10), at(11)).equals(TimeRange.create(at(10), at(11)))).toBe(true);
      expect(TimeRange.create(at(10), at(11)).equals(TimeRange.create(at(10), at(12)))).toBe(false);
      expect(TimeRange.create(at(10), at(11)).equals(null)).toBe(false);
    });

    it('serializa con la duración calculada', () => {
      expect(TimeRange.create(at(10), at(11)).toJSON()).toEqual({
        startsAt: '2026-09-10T10:00:00.000Z',
        endsAt: '2026-09-10T11:00:00.000Z',
        durationMinutes: 60,
      });
    });

    it('la representación textual muestra la semántica semiabierta', () => {
      expect(TimeRange.create(at(10), at(11)).toString()).toBe(
        '[2026-09-10T10:00:00.000Z, 2026-09-10T11:00:00.000Z)',
      );
    });
  });
});

describe('Percentage', () => {
  it('crea porcentajes válidos', () => {
    expect(Percentage.create(21).value).toBe(21);
    expect(Percentage.create(0).value).toBe(0);
    expect(Percentage.create(100).value).toBe(100);
  });

  it('resuelve la ambigüedad clásica entre 21 y 0,21', () => {
    expect(Percentage.create(21).asFraction).toBe(0.21);
  });

  it('redondea a dos decimales', () => {
    expect(Percentage.create(15.456).value).toBe(15.46);
  });

  it('rechaza valores fuera de rango', () => {
    expect(() => Percentage.create(-1)).toThrow(DomainValidationError);
    expect(() => Percentage.create(101)).toThrow(DomainValidationError);
    expect(() => Percentage.create(Number.NaN)).toThrow(DomainValidationError);
  });

  it('expone el cero y su predicado', () => {
    expect(Percentage.zero().isZero()).toBe(true);
    expect(Percentage.create(1).isZero()).toBe(false);
  });

  it('serializa como número y se imprime con el símbolo', () => {
    expect(Percentage.create(21).toJSON()).toBe(21);
    expect(Percentage.create(21).toString()).toBe('21%');
  });
});
