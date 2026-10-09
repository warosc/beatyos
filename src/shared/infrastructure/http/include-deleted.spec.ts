import type { AccessTokenClaims } from '../../application/ports';
import { includeDeletedFor } from './include-deleted';

const user = (permissions: string[]) => ({ permissions }) as unknown as AccessTokenClaims;

describe('includeDeletedFor', () => {
  it('lo concede a quien puede restaurar el recurso', () => {
    expect(includeDeletedFor(true, user(['clients.restore']), 'clients.restore')).toBe(true);
    expect(includeDeletedFor(true, user(['*']), 'clients.restore')).toBe(true);
  });

  it('lo ignora en silencio para quien solo puede leer', () => {
    expect(includeDeletedFor(true, user(['clients.read']), 'clients.restore')).toBe(false);
  });

  it('no lo activa si no se pidió', () => {
    expect(includeDeletedFor(undefined, user(['*']), 'clients.restore')).toBe(false);
    expect(includeDeletedFor(false, user(['*']), 'clients.restore')).toBe(false);
  });
});
