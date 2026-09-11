import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { GET, POST } from './route';

const rotated = {
  data: {
    accessToken: 'at2',
    refreshToken: 'rt2',
    tokenType: 'Bearer',
    expiresIn: 900,
    user: { id: 'u1' },
  },
};
beforeEach(() => {
  jar.value = { beautyos_refresh: 'rt1' };
});
afterEach(() => vi.unstubAllGlobals());

describe('renovación de sesión', () => {
  it('no llama a la API sin refresh token', async () => {
    jar.value = {};
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await POST()).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rota las dos cookies para que el refresh usado no siga sirviendo', async () => {
    const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json(rotated),
    );
    vi.stubGlobal('fetch', upstream);
    const response = await POST();
    expect(JSON.parse(upstream.mock.calls[0][1].body as string)).toEqual({
      refreshToken: 'rt1',
    });
    expect(response.cookies.get('beautyos_access')?.value).toBe('at2');
    expect(response.cookies.get('beautyos_refresh')?.value).toBe('rt2');
    expect(await response.json()).toEqual({ user: rotated.data.user });
  });

  it('borra las cookies cuando la API rechaza el refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'expirado' }, { status: 401 })),
    );
    const response = await POST();
    expect(response.status).toBe(401);
    expect(response.cookies.get('beautyos_access')?.value).toBe('');
    expect(response.cookies.get('beautyos_refresh')?.value).toBe('');
  });

  it('conserva las cookies si la API está caída, para no cerrar sesión por un bache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const response = await POST();
    expect(response.status).toBe(503);
    expect(response.cookies.get('beautyos_refresh')).toBeUndefined();
  });
});

describe('vuelta a la página que el usuario estaba viendo', () => {
  const visit = (returnTo: string) =>
    GET(
      new NextRequest(`http://localhost/api/auth/refresh?returnTo=${encodeURIComponent(returnTo)}`),
    );

  it('conserva un destino local', async () => {
    const location = new URL((await visit('/caja?turno=1')).headers.get('location')!);
    expect(location.pathname).toBe('/session');
    expect(location.searchParams.get('returnTo')).toBe('/caja?turno=1');
  });

  it.each(['https://evil.example', '//evil.example', '/api/auth/refresh'])(
    'descarta el destino %s',
    async (path) => {
      const location = new URL((await visit(path)).headers.get('location')!);
      expect(location.searchParams.get('returnTo')).toBe('/');
    },
  );
});
