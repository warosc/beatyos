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
const url = (query: string) => `http://localhost/api/cash?${query}`;
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: {} }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('caja', () => {
  it('exige sesión antes de consultar el turno', async () => {
    jar.value = {};
    expect((await GET(new NextRequest(url('resource=current')))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['balance', 'reports', ''])('no deja abrir el proxy al recurso %s', async (resource) => {
    expect((await GET(new NextRequest(url(`resource=${resource}`)))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['current', /\/cash\/current$/],
    ['history', /\/cash\/history$/],
  ])('consulta %s en su ruta', async (resource, path) => {
    await GET(new NextRequest(url(`resource=${resource}`)));
    expect(calledUrl().pathname).toMatch(path);
  });

  it.each([
    ['open', /\/cash\/open$/],
    ['movement', /\/cash\/movements$/],
    ['close', /\/cash\/close$/],
  ])('envía la operación %s con el cuerpo del formulario', async (resource, path) => {
    const body = JSON.stringify({ amount: 500 });
    await POST(new NextRequest(url(`resource=${resource}`), { method: 'POST', body }));
    expect(calledUrl().pathname).toMatch(path);
    expect((upstream.mock.calls[0][1] as RequestInit).body).toBe(body);
  });

  it('pagina el histórico sin colar otros parámetros', async () => {
    await GET(new NextRequest(url('resource=history&page=3&limit=50&sessionId=otra')));
    const query = calledUrl().searchParams;
    expect([query.get('page'), query.get('limit')]).toEqual(['3', '50']);
    expect(query.get('sessionId')).toBeNull();
    expect(query.get('resource')).toBeNull();
  });

  it('deja llegar el conflicto de una caja ya abierta', async () => {
    upstream.mockResolvedValue(
      Response.json({ detail: 'La caja ya está abierta.' }, { status: 409 }),
    );
    const response = await POST(
      new NextRequest(url('resource=open'), { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'La caja ya está abierta.' });
  });
});
