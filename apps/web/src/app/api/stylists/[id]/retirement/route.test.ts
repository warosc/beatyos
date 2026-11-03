import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { GET } from './route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (id: string) =>
  GET(
    new NextRequest(`http://localhost/api/stylists/${id}/retirement`, { method: 'GET' }),
    context(id),
  );
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 's1' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('retirement de una profesional', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await call('s1')).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('llama al backend con el token de la sesión', async () => {
    const response = await call('s1');
    expect(response.status).toBe(200);
    expect(calledUrl().pathname).toMatch(/\/stylists\/s1\/retirement$/);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
  });

  it('codifica el identificador para no salirse del recurso', async () => {
    await call('../users');
    expect(calledUrl().pathname).toMatch(/\/stylists\/\.\.%2Fusers\/retirement$/);
  });

  it('no se rompe si la API contesta algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
    const response = await call('s1');
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
  });
});
