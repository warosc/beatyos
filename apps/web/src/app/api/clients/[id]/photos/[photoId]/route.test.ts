import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { DELETE, PATCH } from './route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string, photoId: string) => ({ params: Promise.resolve({ id, photoId }) });
const request = (method: string, body?: string) =>
  new NextRequest('http://localhost/api/clients/c1/photos/p1', { method, body });
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 'p1' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('una foto puntual de la galería', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await PATCH(request('PATCH'), context('c1', 'p1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('envía la descripción corregida por PATCH', async () => {
    const body = JSON.stringify({ caption: 'Base 7 + 30ml oxidante 20vol' });
    await PATCH(request('PATCH', body), context('c1', 'p1'));
    expect(calledUrl().pathname).toMatch(/\/clients\/c1\/photos\/p1$/);
    expect((upstream.mock.calls[0][1] as RequestInit).body).toBe(body);
  });

  it('devuelve la baja como 204 sin cuerpo', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    const response = await DELETE(request('DELETE'), context('c1', 'p1'));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('no se rompe si la API contesta algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
    const response = await PATCH(request('PATCH', '{}'), context('c1', 'p1'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
  });
});
