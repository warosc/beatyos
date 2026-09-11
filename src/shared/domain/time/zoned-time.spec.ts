import { DomainValidationError } from '../errors';
import {
  addCalendarDays,
  dayOfWeekInZone,
  formatCalendarDay,
  formatMinutes,
  instantToCalendarDay,
  isSameCalendarDay,
  isValidTimeZone,
  minutesFromMidnightInZone,
  parseCalendarDay,
  parseMinutes,
  timeZoneOffsetMs,
  zonedTimeToInstant,
} from './zoned-time';

/**
 * Conversión entre hora de salón e instantes absolutos.
 *
 * Los tests importantes son los de los dos domingos del año en que cambia la hora. Es
 * cuando fallan las implementaciones ingenuas, y es también cuando el fallo cuesta más
 * de encontrar: aparece de golpe, afecta a citas ya reservadas y desaparece seis meses
 * después.
 */
describe('zoned-time', () => {
  const MADRID = 'Europe/Madrid';
  const BOGOTA = 'America/Bogota'; // sin cambio de hora
  const MEXICO = 'America/Mexico_City';

  describe('zonedTimeToInstant', () => {
    it('convierte una hora de invierno (UTC+1 en Madrid)', () => {
      const instant = zonedTimeToInstant({ year: 2026, month: 1, day: 15 }, 9 * 60, MADRID);
      expect(instant.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    });

    it('convierte una hora de verano (UTC+2 en Madrid)', () => {
      // Mismo horario de salón, distinto instante absoluto. Es exactamente lo que una
      // implementación ingenua se pierde.
      const instant = zonedTimeToInstant({ year: 2026, month: 7, day: 15 }, 9 * 60, MADRID);
      expect(instant.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    });

    it('no depende de la zona horaria del servidor', () => {
      // Un contenedor en UTC gestionando un salón de Madrid: el resultado debe ser el
      // mismo que en cualquier otra máquina.
      const instant = zonedTimeToInstant({ year: 2026, month: 3, day: 10 }, 10 * 60 + 30, MADRID);
      expect(instant.toISOString()).toBe('2026-03-10T09:30:00.000Z');
    });

    it('funciona en zonas sin cambio de hora', () => {
      const enero = zonedTimeToInstant({ year: 2026, month: 1, day: 15 }, 9 * 60, BOGOTA);
      const julio = zonedTimeToInstant({ year: 2026, month: 7, day: 15 }, 9 * 60, BOGOTA);

      expect(enero.toISOString()).toBe('2026-01-15T14:00:00.000Z');
      expect(julio.toISOString()).toBe('2026-07-15T14:00:00.000Z');
    });

    it('funciona en zonas al oeste del meridiano', () => {
      const instant = zonedTimeToInstant({ year: 2026, month: 1, day: 15 }, 9 * 60, MEXICO);
      expect(instant.toISOString()).toBe('2026-01-15T15:00:00.000Z');
    });

    describe('días del cambio de hora', () => {
      // En 2026, España adelanta el reloj el 29 de marzo y lo atrasa el 25 de octubre.
      const SPRING_FORWARD = { year: 2026, month: 3, day: 29 };
      const FALL_BACK = { year: 2026, month: 10, day: 25 };

      it('un horario normal de salón no se ve afectado en marzo', () => {
        // El salón abre a las 9:00 tanto ese domingo como cualquier otro; lo que cambia
        // es el instante absoluto, y eso es justo lo que hay que calcular bien.
        const instant = zonedTimeToInstant(SPRING_FORWARD, 9 * 60, MADRID);
        expect(instant.toISOString()).toBe('2026-03-29T07:00:00.000Z');
      });

      it('un horario normal de salón no se ve afectado en octubre', () => {
        const instant = zonedTimeToInstant(FALL_BACK, 9 * 60, MADRID);
        expect(instant.toISOString()).toBe('2026-10-25T08:00:00.000Z');
      });

      it('una hora inexistente se desplaza en vez de fallar', () => {
        // Las 02:30 del 29 de marzo no existen: el reloj salta de 02:00 a 03:00. Para una
        // agenda, mover la cita media hora es preferible a rechazar la reserva con un
        // error que nadie sabría interpretar.
        const instant = zonedTimeToInstant(SPRING_FORWARD, 2 * 60 + 30, MADRID);

        expect(instant).toBeInstanceOf(Date);
        expect(Number.isNaN(instant.getTime())).toBe(false);
        // Cae ya en horario de verano.
        expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
      });

      it('una hora ambigua elige la primera aparición', () => {
        // Las 02:30 del 25 de octubre ocurren dos veces. Se toma la primera, que es lo
        // que espera cualquiera al mirar un calendario.
        const instant = zonedTimeToInstant(FALL_BACK, 2 * 60 + 30, MADRID);
        expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
      });

      it('la ida y vuelta es coherente fuera de las horas problemáticas', () => {
        for (const day of [SPRING_FORWARD, FALL_BACK]) {
          for (const minutes of [9 * 60, 13 * 60, 18 * 60]) {
            const instant = zonedTimeToInstant(day, minutes, MADRID);

            expect(minutesFromMidnightInZone(instant, MADRID)).toBe(minutes);
            expect(isSameCalendarDay(instantToCalendarDay(instant, MADRID), day)).toBe(true);
          }
        }
      });
    });

    it('admite la medianoche y el final del día', () => {
      expect(() => zonedTimeToInstant({ year: 2026, month: 5, day: 1 }, 0, MADRID)).not.toThrow();
      expect(() =>
        zonedTimeToInstant({ year: 2026, month: 5, day: 1 }, 1440, MADRID),
      ).not.toThrow();
    });

    it('rechaza minutos fuera de rango', () => {
      const day = { year: 2026, month: 5, day: 1 };
      expect(() => zonedTimeToInstant(day, -1, MADRID)).toThrow(DomainValidationError);
      expect(() => zonedTimeToInstant(day, 1441, MADRID)).toThrow(DomainValidationError);
      expect(() => zonedTimeToInstant(day, 90.5, MADRID)).toThrow(DomainValidationError);
    });
  });

  describe('timeZoneOffsetMs', () => {
    it('devuelve el desplazamiento vigente en cada época del año', () => {
      expect(timeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), MADRID)).toBe(3_600_000);
      expect(timeZoneOffsetMs(new Date('2026-07-15T12:00:00Z'), MADRID)).toBe(7_200_000);
    });

    it('es cero en UTC y negativo al oeste', () => {
      expect(timeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe(0);
      expect(timeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), BOGOTA)).toBe(-18_000_000);
    });
  });

  describe('dayOfWeekInZone', () => {
    it('usa el día local, no el del servidor', () => {
      // 00:30 del lunes en Madrid es todavía domingo en UTC. Con el día equivocado, el
      // horario del lunes no se aplicaría.
      const lunesDeMadrugada = new Date('2026-09-06T22:30:00Z'); // lunes 00:30 en Madrid
      expect(dayOfWeekInZone(lunesDeMadrugada, MADRID)).toBe(1);
      expect(dayOfWeekInZone(lunesDeMadrugada, 'UTC')).toBe(0);
    });

    it('numera de domingo (0) a sábado (6)', () => {
      expect(dayOfWeekInZone(new Date('2026-09-06T12:00:00Z'), MADRID)).toBe(0);
      expect(dayOfWeekInZone(new Date('2026-09-12T12:00:00Z'), MADRID)).toBe(6);
    });
  });

  describe('minutesFromMidnightInZone', () => {
    it('devuelve la hora local', () => {
      expect(minutesFromMidnightInZone(new Date('2026-07-15T07:00:00Z'), MADRID)).toBe(540);
      expect(minutesFromMidnightInZone(new Date('2026-01-15T08:30:00Z'), MADRID)).toBe(570);
    });

    it('la medianoche local es cero', () => {
      expect(minutesFromMidnightInZone(new Date('2026-07-14T22:00:00Z'), MADRID)).toBe(0);
    });
  });

  describe('calendario', () => {
    it('suma días sobre el calendario, no sobre milisegundos', () => {
      // El día del cambio de hora tiene 23 o 25 horas: sumar 86 400 000 ms daría el día
      // equivocado.
      expect(addCalendarDays({ year: 2026, month: 3, day: 28 }, 1)).toEqual({
        year: 2026,
        month: 3,
        day: 29,
      });
    });

    it('cruza meses, años y bisiestos', () => {
      expect(addCalendarDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
        year: 2026,
        month: 2,
        day: 1,
      });
      expect(addCalendarDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
        year: 2027,
        month: 1,
        day: 1,
      });
      expect(addCalendarDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({
        year: 2028,
        month: 2,
        day: 29,
      });
    });

    it('retrocede con días negativos', () => {
      expect(addCalendarDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
        year: 2026,
        month: 2,
        day: 28,
      });
    });

    it('compara días', () => {
      const day = { year: 2026, month: 9, day: 10 };
      expect(isSameCalendarDay(day, { ...day })).toBe(true);
      expect(isSameCalendarDay(day, { ...day, day: 11 })).toBe(false);
    });
  });

  describe('formato y análisis', () => {
    it('formatea y reinterpreta días ISO', () => {
      expect(formatCalendarDay({ year: 2026, month: 9, day: 5 })).toBe('2026-09-05');
      expect(parseCalendarDay('2026-09-05')).toEqual({ year: 2026, month: 9, day: 5 });
    });

    it('rechaza fechas mal formadas', () => {
      expect(() => parseCalendarDay('5/9/2026')).toThrow(DomainValidationError);
      expect(() => parseCalendarDay('2026-9-5')).toThrow(DomainValidationError);
    });

    it('rechaza fechas que no existen', () => {
      // `2026-02-31` encaja con la expresión regular; `Date.UTC` la convertiría en el 3
      // de marzo sin decir nada.
      expect(() => parseCalendarDay('2026-02-31')).toThrow(/no existe/);
      expect(() => parseCalendarDay('2026-13-01')).toThrow(DomainValidationError);
    });

    it('formatea y reinterpreta horas', () => {
      expect(formatMinutes(540)).toBe('09:00');
      expect(formatMinutes(0)).toBe('00:00');
      expect(formatMinutes(1439)).toBe('23:59');
      expect(parseMinutes('09:00')).toBe(540);
      expect(parseMinutes('9:30')).toBe(570);
    });

    it('rechaza horas mal formadas', () => {
      expect(() => parseMinutes('9h30')).toThrow(DomainValidationError);
      expect(() => parseMinutes('09:75')).toThrow(DomainValidationError);
      expect(() => parseMinutes('25:00')).toThrow(DomainValidationError);
    });
  });

  describe('isValidTimeZone', () => {
    it('acepta zonas IANA reales', () => {
      expect(isValidTimeZone(MADRID)).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone(BOGOTA)).toBe(true);
    });

    it('rechaza zonas inventadas', () => {
      expect(isValidTimeZone('Europa/Madrid')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
    });
  });
});
