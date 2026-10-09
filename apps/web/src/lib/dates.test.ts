import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayRange, localDay } from './dates';

describe('fechas del salón', () => {
  afterEach(() => vi.useRealTimers());

  it('a las 18:30 sigue siendo hoy, aunque en UTC ya sea mañana', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 8, 18, 30));
    expect(localDay()).toBe('2026-10-08');
  });

  it('el día completo va de medianoche a medianoche en la hora local', () => {
    const { from, to } = dayRange('2026-10-08');
    expect([from.getHours(), from.getDate()]).toEqual([0, 8]);
    expect([to.getHours(), to.getMinutes(), to.getDate()]).toEqual([23, 59, 8]);
  });
});
