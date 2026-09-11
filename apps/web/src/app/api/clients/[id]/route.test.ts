import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { DELETE, GET, PATCH } from './route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (id: string, method: string, body?: string) =>
  new NextRequest(`http://localhost/api/clients/${id}`, { method, body });
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 'c1' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('ficha de una clienta', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await GET(request('c1', 'GET'), context('c1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('consulta la ficha con el token de la sesión', async () => {
    await GET(request('c1', 'GET'), context('c1'));
    expect(calledUrl().pathname).toMatch(/\/clients\/c1$/);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
    expect(init.body).toBeUndefined();
  });

  it('envía solo en el PATCH los cambios del formulario', async () => {
    const body = JSON.stringify({ allergies: 'Ninguna' });
    await PATCH(request('c1', 'PATCH', body), context('c1'));
    expect((upstream.mock.calls[0][1] as RequestInit).body).toBe(body);
  });

  it('devuelve la baja como 204 sin cuerpo', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    const response = await DELETE(request('c1', 'DELETE'), context('c1'));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('codifica el identificador para no salirse del recurso', async () => {
    await GET(request('x', 'GET'), context('../users'));
    expect(calledUrl().pathname).toMatch(/\/clients\/\.\.%2Fusers$/);
  });

  it('no se rompe si la API contesta algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
    const response = await GET(request('c1', 'GET'), context('c1'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
  });
});
