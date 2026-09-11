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
const url = (query: string) => `http://localhost/api/purchases?${query}`;
const send = (query: string) => POST(new NextRequest(url(query), { method: 'POST', body: '{}' }));
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('abastecimiento', () => {
  it.each([
    ['suppliers', /\/suppliers$/],
    ['products', /\/products$/],
    ['orders', /\/purchases$/],
  ])('lista %s desde el recurso correcto', async (resource, path) => {
    await GET(new NextRequest(url(`resource=${resource}`)));
    expect(calledUrl().pathname).toMatch(path);
  });

  it('traslada solo los filtros que la API entiende', async () => {
    await GET(
      new NextRequest(url('resource=orders&page=2&limit=10&search=tinte&status=DRAFT&sort=x')),
    );
    const query = calledUrl().searchParams;
    expect([
      query.get('page'),
      query.get('limit'),
      query.get('search'),
      query.get('status'),
    ]).toEqual(['2', '10', 'tinte', 'DRAFT']);
    expect(query.get('sort')).toBeNull();
    expect(query.get('resource')).toBeNull();
  });

  it('da de alta un proveedor en su propio recurso', async () => {
    await send('resource=supplier');
    expect(calledUrl().pathname).toMatch(/\/suppliers$/);
  });

  it.each(['submit', 'receive', 'cancel'])('envía la acción %s de una orden', async (action) => {
    await send(`id=po-1&action=${action}`);
    expect(calledUrl().pathname).toMatch(new RegExp(`/purchases/po-1/${action}$`));
  });

  it('no deja que una acción inventada saque la petición del recurso de compras', async () => {
    const response = await send(`id=po-1&action=${encodeURIComponent('../../users')}`);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('crea la orden cuando no hay acción', async () => {
    await send('');
    expect(calledUrl().pathname).toMatch(/\/purchases$/);
  });

  it('exige sesión en el listado y en las acciones', async () => {
    jar.value = {};
    expect((await GET(new NextRequest(url('resource=orders')))).status).toBe(401);
    expect((await send('id=po-1&action=submit')).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('devuelve un 204 sin cuerpo en lugar de romperse', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    expect((await send('id=po-1&action=cancel')).status).toBe(204);
  });
});
