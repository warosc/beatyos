import { describe, expect, it } from 'vitest';
import { hourLabel, hourParts, hourRange, insightText } from './stats';
import { approximateWait, minutesLabel, minutesSince, waitTone } from './types';

describe('cifras de la fila', () => {
  it('dice la hora como se dice en el salón', () => {
    expect(hourLabel(0)).toBe('12 a. m.');
    expect(hourLabel(9)).toBe('9 a. m.');
    expect(hourLabel(12)).toBe('12 p. m.');
    expect(hourLabel(16)).toBe('4 p. m.');
    expect(hourRange(16)).toBe('de 4 a 5 p. m.');
    expect(hourRange(11)).toBe('de 11 a 12 p. m.');
  });

  it('parte la hora en dos líneas para el eje', () => {
    expect(hourParts(9)).toEqual({ number: '9', suffix: 'a. m.' });
    expect(hourParts(16)).toEqual({ number: '4', suffix: 'p. m.' });
  });

  it('no promete esperas de cero minutos', () => {
    expect(approximateWait(0)).toBe('menos de 5 min');
    expect(approximateWait(4)).toBe('menos de 5 min');
    expect(approximateWait(20)).toBe('20 min');
  });

  it('escribe los minutos en minutos o en horas', () => {
    expect(minutesLabel(12)).toBe('12 min');
    expect(minutesLabel(60)).toBe('1 h');
    expect(minutesLabel(85)).toBe('1 h 25 min');
  });

  it('cuenta los minutos sin dar esperas negativas', () => {
    const now = new Date('2026-10-12T15:00:00.000Z');
    expect(minutesSince('2026-10-12T14:48:30.000Z', now)).toBe(11);
    expect(minutesSince('2026-10-12T15:05:00.000Z', now)).toBe(0);
  });

  it('pinta la espera a partir de los 15 y los 30 minutos', () => {
    expect(waitTone(14)).toBe('calm');
    expect(waitTone(15)).toBe('attention');
    expect(waitTone(30)).toBe('late');
  });

  it('redacta cada conclusión con la decisión que sugiere', () => {
    expect(insightText({ kind: 'peak-hour', hour: 16, arrivals: 9 }).title).toBe(
      'La hora con más llegadas es de 4 a 5 p. m.',
    );
    expect(insightText({ kind: 'slowest-hour', hour: 10, averageWait: 32 }).title).toBe(
      'De 10 a 11 a. m. se espera más: 32 min de media',
    );
    expect(insightText({ kind: 'leave-after', minutes: 25, samples: 6 }).title).toBe(
      'Las que se van aguantan unos 25 min',
    );
    expect(insightText({ kind: 'busiest-weekday', weekday: 6, arrivalsPerDay: 7.5 }).title).toBe(
      'El sábado llegan más clientas sin cita',
    );
    expect(
      insightText({ kind: 'most-requested', stylistId: 's', stylistName: 'Sara', requested: 4 })
        .hint,
    ).toContain('4 clientas la pidieron');
  });
});
