import { describe, expect, it } from 'vitest';
import {
  addDays,
  isoDay,
  layoutLanes,
  minutesInDay,
  plural,
  shortTime,
  snap,
  startOfWeek,
  visibleHours,
} from './time';

const at = (hour: number, minute = 0) => new Date(2026, 9, 8, hour, minute).toISOString();

describe('fechas de la agenda', () => {
  it('la semana empieza el lunes, también si hoy es domingo', () => {
    expect(isoDay(startOfWeek(new Date(2026, 9, 8)))).toBe('2026-10-05');
    expect(isoDay(startOfWeek(new Date(2026, 9, 11)))).toBe('2026-10-05');
  });

  it('sumar días cruza meses sin errores', () => {
    expect(isoDay(addDays(new Date(2026, 9, 30), 3))).toBe('2026-11-02');
  });

  it('minutos desde la medianoche del día dado', () => {
    expect(minutesInDay(at(9, 30), new Date(2026, 9, 8))).toBe(570);
  });

  it('redondea a la rejilla de un cuarto de hora', () => {
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(52)).toBe(45);
  });

  it('hora corta y plurales', () => {
    expect(shortTime(at(15, 5))).toBe('3:05');
    expect(shortTime(at(0, 30))).toBe('12:30');
    expect(plural(1, 'cita', 'citas')).toBe('1 cita');
    expect(plural(3, 'cita', 'citas')).toBe('3 citas');
  });
});

describe('horas visibles de la parrilla', () => {
  it('sin datos, de 8 a 19', () => {
    expect(visibleHours([])).toEqual({ start: 480, end: 1140 });
  });

  it('se amplía a horas enteras para no esconder una cita temprana o tardía', () => {
    expect(visibleHours([{ start: 7 * 60 + 15, end: 20 * 60 + 10 }])).toEqual({
      start: 420,
      end: 1260,
    });
  });
});

describe('carriles para citas que se solapan', () => {
  it('las que no se tocan van a lo ancho', () => {
    const laid = layoutLanes([
      { id: 'a', startsAt: at(9), endsAt: at(10) },
      { id: 'b', startsAt: at(10), endsAt: at(11) },
    ]);
    expect(laid.map(({ lane, lanes }) => [lane, lanes])).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it('las que se solapan se reparten y comparten ancho dentro de su grupo', () => {
    const laid = layoutLanes([
      { id: 'a', startsAt: at(9), endsAt: at(11) },
      { id: 'b', startsAt: at(9, 30), endsAt: at(10) },
      { id: 'c', startsAt: at(10), endsAt: at(10, 30) },
      { id: 'd', startsAt: at(12), endsAt: at(13) },
    ]);
    const byId = Object.fromEntries(laid.map((entry) => [entry.item.id, entry]));
    expect(byId.a).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId.b).toMatchObject({ lane: 1, lanes: 2 });
    // «c» reutiliza el carril que dejó libre «b».
    expect(byId.c).toMatchObject({ lane: 1, lanes: 2 });
    expect(byId.d).toMatchObject({ lane: 0, lanes: 1 });
  });
});
