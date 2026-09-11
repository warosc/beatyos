import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './safe-return-path';
describe('destinos locales después de renovar sesión', () => {
  it.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '/\nevil.example',
    '/api/auth/refresh',
    '/session?returnTo=/session',
  ])('rechaza %s', (path) => expect(safeReturnPath(path)).toBe('/'));
  it('conserva página, filtros y fragmento', () =>
    expect(safeReturnPath('/clientes?search=Ana#ficha')).toBe('/clientes?search=Ana#ficha'));
});
