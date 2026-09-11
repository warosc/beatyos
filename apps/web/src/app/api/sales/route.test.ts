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

describe('ventas', () => {
  it('no deja consultar ni cobrar sin sesión', async () => {
    jar.value = {};
    expect((await GET(new NextRequest('http://localhost/api/sales'))).status).toBe(401);
    expect(
      (await POST(new NextRequest('http://localhost/api/sales', { method: 'POST', body: '{}' })))
        .status,
    ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('traslada el filtro del listado', async () => {
    await GET(new NextRequest('http://localhost/api/sales?page=2&from=2026-01-01'));
    const query = new URL(upstream.mock.calls[0][0] as string).searchParams;
    expect([query.get('page'), query.get('from')]).toEqual(['2', '2026-01-01']);
  });

  it('cobra enviando el ticket firmado con la sesión y sin la consulta', async () => {
    const body = JSON.stringify({ lines: [{ productId: 'p1', quantity: 2 }] });
    await POST(new NextRequest('http://localhost/api/sales?page=2', { method: 'POST', body }));
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sales$/);
    expect(init.body).toBe(body);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
  });

  it('devuelve el motivo por el que la venta no se pudo cerrar', async () => {
    upstream.mockResolvedValue(Response.json({ detail: 'Sin existencias.' }, { status: 409 }));
    const response = await POST(
      new NextRequest('http://localhost/api/sales', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'Sin existencias.' });
  });
});
