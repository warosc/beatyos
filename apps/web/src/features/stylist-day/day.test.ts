import { describe, expect, it } from 'vitest';
import type { Appointment } from '@/features/agenda/types';
import type { ServiceTicket } from '@/features/service-tickets/types';
import { classifyDay, since } from './day';

const NOW = new Date('2026-09-30T16:00:00.000Z');
const at = (minutesFromNow: number) =>
  new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

const appointment = (id: string, start: number, end: number, status = 'SCHEDULED') =>
  ({
    id,
    clientId: `client-${id}`,
    stylistId: 'me',
    startsAt: at(start),
    endsAt: at(end),
    status,
    services: [],
  }) as unknown as Appointment;

const ticket = (appointmentId: string | null, status = 'PENDING') =>
  ({ id: `t-${appointmentId}`, appointmentId, status }) as unknown as ServiceTicket;

describe('el día de la profesional', () => {
  it('toma sola la cita cuya hora ya llegó, sin que nadie pulse empezar', () => {
    const day = classifyDay([appointment('a', -10, 50)], [], NOW);
    expect(day.now.map((a) => a.id)).toEqual(['a']);
    expect(day.pendingCount).toBe(1);
  });

  it('separa lo que ya terminó sin declarar de lo que aún no empieza', () => {
    const day = classifyDay(
      [
        appointment('tarde', 60, 120),
        appointment('pasada', -120, -60),
        appointment('ahora', -5, 40),
      ],
      [],
      NOW,
    );
    expect(day.overdue.map((a) => a.id)).toEqual(['pasada']);
    expect(day.now.map((a) => a.id)).toEqual(['ahora']);
    expect(day.upcoming.map((a) => a.id)).toEqual(['tarde']);
    expect(day.pendingCount).toBe(2);
  });

  it('deja de recordar una cita en cuanto se envía a caja', () => {
    const day = classifyDay([appointment('a', -120, -60)], [ticket('a')], NOW);
    expect(day.overdue).toHaveLength(0);
    expect(day.pendingCount).toBe(0);
  });

  it('vuelve a recordarla si la comanda se anuló', () => {
    const day = classifyDay([appointment('a', -120, -60)], [ticket('a', 'CANCELLED')], NOW);
    expect(day.overdue.map((a) => a.id)).toEqual(['a']);
  });

  it('no pide declarar una cita cancelada ni una a la que la clienta no vino', () => {
    const day = classifyDay(
      [appointment('c', -120, -60, 'CANCELLED'), appointment('n', -120, -60, 'NO_SHOW')],
      [],
      NOW,
    );
    expect(day.pendingCount).toBe(0);
  });

  it('una cita marcada en curso sigue siendo la de ahora aunque se pase de hora', () => {
    const day = classifyDay([appointment('a', -90, -30, 'IN_PROGRESS')], [], NOW);
    expect(day.now.map((a) => a.id)).toEqual(['a']);
  });

  it('dice cuánto lleva sin declararse', () => {
    expect(since(at(-40), NOW)).toBe('hace 40 min');
    expect(since(at(-125), NOW)).toBe('hace 2 h 5 min');
    expect(since(at(0), NOW)).toBe('ahora mismo');
  });
});
