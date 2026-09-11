import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { DELETE, GET, PATCH, POST } from './route';

const url = (query: string) => `http://localhost/api/admin?${query}`;
let upstream: ReturnType<typeof vi.fn>;
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('consola de administración', () => {
  it('exige sesión antes de tocar la API', async () => {
    jar.value = {};
    expect((await GET(new NextRequest(url('resource=users')))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['tenants', 'audit', ''])(
    'no deja usar el proxy para el recurso %s',
    async (resource) => {
      const response = await GET(new NextRequest(url(`resource=${resource}`)));
      expect(response.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('firma la petición con el token de la sesión', async () => {
    await GET(new NextRequest(url('resource=users')));
    const headers = (upstream.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at');
  });

  it('traslada los filtros del listado sin colar el parámetro interno resource', async () => {
    await GET(new NextRequest(url('resource=users&page=2&limit=20&search=ana')));
    const query = calledUrl().searchParams;
    expect(query.get('resource')).toBeNull();
    expect([query.get('page'), query.get('limit'), query.get('search')]).toEqual([
      '2',
      '20',
      'ana',
    ]);
  });

  it('resuelve el catálogo de permisos bajo roles', async () => {
    await GET(new NextRequest(url('resource=permissions')));
    expect(calledUrl().pathname).toMatch(/\/roles\/permissions$/);
  });

  it('codifica el identificador en la ruta', async () => {
    await PATCH(new NextRequest(url('resource=users&id=u%2F1'), { method: 'PATCH', body: '{}' }));
    expect(calledUrl().pathname).toMatch(/\/users\/u%2F1$/);
  });

  it.each([
    ['roles', /\/users\/u1\/roles$/],
    ['restore', /\/users\/u1\/restore$/],
  ])('envía la acción %s al subrecurso del usuario', async (action, path) => {
    await POST(
      new NextRequest(url(`resource=users&id=u1&action=${action}`), { method: 'POST', body: '{}' }),
    );
    expect(calledUrl().pathname).toMatch(path);
  });

  it('ignora una acción suelta sin identificador', async () => {
    await POST(
      new NextRequest(url('resource=users&action=restore'), { method: 'POST', body: '{}' }),
    );
    expect(calledUrl().pathname).toMatch(/\/users$/);
  });

  it('devuelve un 204 sin cuerpo en lugar de romperse al leerlo', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    const response = await DELETE(
      new NextRequest(url('resource=users&id=u1'), { method: 'DELETE' }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('conserva el estado y el mensaje de un rechazo de la API', async () => {
    upstream.mockResolvedValue(Response.json({ detail: 'Sin permiso.' }, { status: 403 }));
    const response = await POST(
      new NextRequest(url('resource=roles'), { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Sin permiso.' });
  });
});
