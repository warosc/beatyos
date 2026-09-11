import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { PATCH } from './route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (id: string, body: string) =>
  new NextRequest(`http://localhost/api/stylists/${id}`, { method: 'PATCH', body });
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 's1' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('ficha de un profesional', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await PATCH(request('s1', '{}'), context('s1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('envía la comisión al backend con el token de la sesión', async () => {
    const body = JSON.stringify({ commissionRate: 15 });
    await PATCH(request('s1', body), context('s1'));
    expect(calledUrl().pathname).toMatch(/\/stylists\/s1$/);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
    expect(init.body).toBe(body);
  });

  it('codifica el identificador para no salirse del recurso', async () => {
    await PATCH(request('x', '{}'), context('../stylists'));
    expect(calledUrl().pathname).toMatch(/\/stylists\/\.\.%2Fstylists$/);
  });

  it('no se rompe si la API contesta algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
    const response = await PATCH(request('s1', '{}'), context('s1'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
  });
});
