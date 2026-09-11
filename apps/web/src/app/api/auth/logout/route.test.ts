import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { POST } from './route';

beforeEach(() => {
  jar.value = { beautyos_access: 'at', beautyos_refresh: 'rt' };
});
afterEach(() => vi.unstubAllGlobals());

describe('cierre de sesión', () => {
  it('revoca el refresh token en la API con la sesión actual', async () => {
    const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal('fetch', upstream);
    await POST();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toMatch(/\/auth\/logout$/);
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'rt' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
  });

  it('borra las cookies aunque la API no conteste', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const response = await POST();
    expect(response.status).toBe(200);
    expect(response.cookies.get('beautyos_access')?.value).toBe('');
    expect(response.cookies.get('beautyos_refresh')?.value).toBe('');
  });

  it('no llama a la API si ya no hay refresh token que revocar', async () => {
    jar.value = { beautyos_access: 'at' };
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await POST();
    expect(upstream).not.toHaveBeenCalled();
    expect(response.cookies.get('beautyos_access')?.value).toBe('');
  });
});
