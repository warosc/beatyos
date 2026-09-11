import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { DELETE } from './route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (id: string) => new NextRequest(`http://localhost/api/goals/${id}`, { method: 'DELETE' });
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('cancelar una meta', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await DELETE(request('g1'), context('g1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('da de baja en el backend con el token de la sesión', async () => {
    const response = await DELETE(request('g1'), context('g1'));
    expect(calledUrl().pathname).toMatch(/\/goals\/g1$/);
    expect((upstream.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer at',
    });
    expect(response.status).toBe(204);
  });

  it('codifica el identificador para no salirse del recurso', async () => {
    await DELETE(request('x'), context('../goals'));
    expect(calledUrl().pathname).toMatch(/\/goals\/\.\.%2Fgoals$/);
  });

  it('no se rompe si la API contesta algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
    const response = await DELETE(request('g1'), context('g1'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
  });
});
