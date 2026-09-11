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
const ask = (query: string) => GET(new NextRequest(`http://localhost/api/reports?${query}`));
beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: {} }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('informes', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await ask('resource=executive')).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['ventas', '../users', ''])('rechaza el informe %s', async (resource) => {
    expect((await ask(`resource=${resource}`)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['executive', 'dashboard'])('resuelve el informe %s', async (resource) => {
    await ask(`resource=${resource}`);
    expect(new URL(upstream.mock.calls[0][0] as string).pathname).toMatch(
      new RegExp(`/reports/${resource}$`),
    );
  });

  it('conserva el rango de fechas y descarta el parámetro interno', async () => {
    await ask('resource=executive&from=2026-01-01&to=2026-01-31');
    const query = new URL(upstream.mock.calls[0][0] as string).searchParams;
    expect(query.get('resource')).toBeNull();
    expect([query.get('from'), query.get('to')]).toEqual(['2026-01-01', '2026-01-31']);
  });

  it('propaga el rechazo de la API sin convertirlo en un informe vacío', async () => {
    upstream.mockResolvedValue(Response.json({ detail: 'Sin permiso.' }, { status: 403 }));
    const response = await ask('resource=executive');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Sin permiso.' });
  });
});
