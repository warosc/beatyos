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

describe('metas e incentivos', () => {
  it('corta la petición sin sesión', async () => {
    jar.value = {};
    expect((await GET(new NextRequest('http://localhost/api/goals'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('traslada la paginación y los filtros del listado', async () => {
    await GET(new NextRequest('http://localhost/api/goals?page=2&limit=20&metric=PRODUCT_REVENUE'));
    const query = new URL(upstream.mock.calls[0][0] as string).searchParams;
    expect([query.get('page'), query.get('limit'), query.get('metric')]).toEqual([
      '2',
      '20',
      'PRODUCT_REVENUE',
    ]);
  });

  it('manda el alta con su cuerpo tal cual', async () => {
    const body = JSON.stringify({ stylistId: 's1', metric: 'PRODUCT_REVENUE', targetAmount: 2000 });
    await POST(new NextRequest('http://localhost/api/goals', { method: 'POST', body }));
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/goals$/);
    expect(init.body).toBe(body);
  });

  it('avisa en vez de romperse si la API devuelve algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const response = await GET(new NextRequest('http://localhost/api/goals'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida del servicio.' });
  });
});
