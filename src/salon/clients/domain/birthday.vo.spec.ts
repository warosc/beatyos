import { DomainValidationError } from '../../../shared/domain/errors';
import { Birthday } from './birthday.vo';

describe('Birthday', () => {
  it('guarda día y mes, sin año', () => {
    const birthday = Birthday.parse('04-17');

    expect([birthday.month, birthday.day]).toEqual([4, 17]);
    expect(birthday.toString()).toBe('04-17');
    expect(birthday.toSpanish()).toBe('17 de abril');
  });

  it('admite el 29 de febrero', () => {
    expect(Birthday.create(2, 29).toString()).toBe('02-29');
  });

  it('rechaza días que el mes no tiene', () => {
    expect(() => Birthday.create(4, 31)).toThrow('Abril no tiene día 31');
    expect(() => Birthday.create(2, 30)).toThrow(DomainValidationError);
    expect(() => Birthday.create(13, 1)).toThrow(DomainValidationError);
  });

  it('rechaza formatos que no son MM-DD', () => {
    expect(() => Birthday.parse('1988-04-17')).toThrow(/MM-DD/);
    expect(() => Birthday.parse('4-17')).toThrow(/MM-DD/);
  });

  describe('próximo cumpleaños', () => {
    const reference = new Date(2026, 9, 9); // 9 de octubre

    it('este año si todavía no ha pasado, contando hoy', () => {
      expect(Birthday.create(10, 9).nextOccurrence(reference)).toEqual(new Date(2026, 9, 9));
      expect(Birthday.create(12, 25).nextOccurrence(reference)).toEqual(new Date(2026, 11, 25));
    });

    it('el año que viene si ya pasó', () => {
      expect(Birthday.create(1, 5).nextOccurrence(reference)).toEqual(new Date(2027, 0, 5));
    });

    it('el 29 de febrero se celebra el 28 en un año no bisiesto', () => {
      expect(Birthday.create(2, 29).nextOccurrence(reference)).toEqual(new Date(2027, 1, 28));
      expect(Birthday.create(2, 29).nextOccurrence(new Date(2027, 5, 1))).toEqual(
        new Date(2028, 1, 29),
      );
    });
  });
});
