import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { GET } from './route';

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 'u1' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('sesión actual', () => {
  it('responde 401 sin cookie para que el cliente sepa que debe renovar', async () => {
    jar.value = {};
    expect((await GET()).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('consulta el perfil con el token de la sesión y sin caché', async () => {
    await GET();
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
    expect(init.cache).toBe('no-store');
  });

  it('distingue una API caída de una sesión caducada', async () => {
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'API no disponible.' });
  });

  it('traslada el rechazo del token tal cual llega', async () => {
    upstream.mockResolvedValue(Response.json({ detail: 'Token vencido.' }, { status: 401 }));
    expect((await GET()).status).toBe(401);
  });
});
