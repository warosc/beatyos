import { describe, expect, it } from 'vitest';
import { announcement, callKey, waitedLabel } from './types';

const call = {
  id: 't7',
  number: 7,
  publicName: 'Ana G.',
  stylistName: 'Sara',
  callCount: 1,
  calledAt: '2026-10-12T15:00:00.000Z',
};

describe('fila de espera', () => {
  it('cuenta la espera en minutos y, pasada la hora, en horas', () => {
    const now = new Date('2026-10-12T15:00:00.000Z');
    expect(waitedLabel('2026-10-12T14:59:40.000Z', now)).toBe('recién llegada');
    expect(waitedLabel('2026-10-12T14:48:00.000Z', now)).toBe('espera 12 min');
    expect(waitedLabel('2026-10-12T13:35:00.000Z', now)).toBe('espera 1 h 25 min');
    // Un reloj adelantado en el equipo no da esperas negativas.
    expect(waitedLabel('2026-10-12T15:05:00.000Z', now)).toBe('recién llegada');
  });

  it('volver a llamar cambia la clave de la llamada: la pantalla vuelve a sonar', () => {
    expect(callKey(call)).not.toBe(callKey({ ...call, callCount: 2 }));
    expect(callKey(call)).toBe(callKey({ ...call }));
  });

  it('la voz dice número, nombre corto y profesional', () => {
    expect(announcement(call)).toBe('Turno 7. Ana G., pase con Sara.');
  });
});
