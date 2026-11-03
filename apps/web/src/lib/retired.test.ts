import { describe, expect, it } from 'vitest';
import { withoutRetiredMark } from './retired';

describe('nombre de una profesional dada de baja', () => {
  it('quita la marca para los papeles de la clienta', () => {
    expect(withoutRetiredMark('Sara (dada de baja)')).toBe('Sara');
  });

  it('deja igual a quien sigue en el equipo', () => {
    expect(withoutRetiredMark('Sara')).toBe('Sara');
  });
});
