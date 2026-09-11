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
const url = (query: string) => `http://localhost/api/agenda?${query}`;
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('agenda', () => {
  it('exige sesión para consultar y para reservar', async () => {
    jar.value = {};
    expect((await GET(new NextRequest(url('resource=calendar')))).status).toBe(401);
    expect((await POST(new NextRequest(url(''), { method: 'POST', body: '{}' }))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['appointments', 'users', ''])('rechaza el recurso %s', async (resource) => {
    expect((await GET(new NextRequest(url(`resource=${resource}`)))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['calendar', /\/appointments\/calendar$/],
    ['availability', /\/appointments\/availability$/],
    ['stylists', /\/stylists$/],
    ['services', /\/services$/],
    ['clients', /\/clients$/],
  ])('resuelve %s en su recurso de la API', async (resource, path) => {
    await GET(new NextRequest(url(`resource=${resource}`)));
    expect(calledUrl().pathname).toMatch(path);
  });

  it('conserva el tramo consultado y descarta el parámetro interno', async () => {
    await GET(new NextRequest(url('resource=calendar&from=2026-09-01&to=2026-09-30')));
    const query = calledUrl().searchParams;
    expect([query.get('from'), query.get('to')]).toEqual(['2026-09-01', '2026-09-30']);
    expect(query.get('resource')).toBeNull();
  });

  it('distingue la API caída de un tramo sin citas', async () => {
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    const response = await GET(new NextRequest(url('resource=calendar')));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'API no disponible.' });
  });

  it('reserva la cita y deja llegar el choque de horario', async () => {
    const body = JSON.stringify({ stylistId: 's1', startsAt: '2026-09-07T15:00:00Z' });
    upstream.mockResolvedValue(
      Response.json({ detail: 'La estilista ya tiene cita.' }, { status: 409 }),
    );
    const response = await POST(new NextRequest(url(''), { method: 'POST', body }));
    const [called, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(called).toMatch(/\/appointments$/);
    expect(init.body).toBe(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'La estilista ya tiene cita.' });
  });
});
