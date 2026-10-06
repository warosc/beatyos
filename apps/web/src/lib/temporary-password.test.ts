import { describe, expect, it } from 'vitest';
import { temporaryPassword } from './temporary-password';

describe('contraseña temporal', () => {
  it('cumple la política de la API, también en el caso más corto', () => {
    // El caso más corto: dos palabras de cuatro letras y cifras con ceros a la izquierda.
    const shortest = temporaryPassword((max) => (max === 10_000 ? 7 : 0));
    expect(shortest).toBe('AguaAgua0007');
    for (let i = 0; i < 200; i++) {
      const password = temporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/\d/);
    }
  });

  it('no repite la misma contraseña', () => {
    const generated = new Set(Array.from({ length: 50 }, () => temporaryPassword()));
    expect(generated.size).toBeGreaterThan(45);
  });
});
