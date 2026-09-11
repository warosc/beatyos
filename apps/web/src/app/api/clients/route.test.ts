import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { GET, POST } from './route';

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('fichas de clientas', () => {
  it('corta la petición sin sesión', async () => {
    jar.value = {};
    expect((await GET(new NextRequest('http://localhost/api/clients'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('traslada la búsqueda y la paginación del listado', async () => {
    await GET(new NextRequest('http://localhost/api/clients?search=Ana&page=2&limit=20'));
    const query = new URL(upstream.mock.calls[0][0] as string).searchParams;
    expect([query.get('search'), query.get('page'), query.get('limit')]).toEqual([
      'Ana',
      '2',
      '20',
    ]);
  });

  it('manda el alta sin arrastrar la consulta del listado', async () => {
    const body = JSON.stringify({ firstName: 'Rosa', lastName: 'Iglesias' });
    await POST(
      new NextRequest('http://localhost/api/clients?search=Ana', { method: 'POST', body }),
    );
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/clients$/);
    expect(init.body).toBe(body);
  });

  it('no inventa un cuerpo cuando la API responde 204', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    const response = await GET(new NextRequest('http://localhost/api/clients'));
    expect(response.status).toBe(204);
  });

  it('avisa en vez de romperse si la API devuelve algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const response = await GET(new NextRequest('http://localhost/api/clients'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida del servicio.' });
  });
});
