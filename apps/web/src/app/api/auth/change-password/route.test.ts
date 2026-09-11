import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { POST } from './route';

const change = (body: unknown) =>
  POST(
    new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
const valid = { currentPassword: 'Antigua12345', newPassword: 'NuevaSegura12345' };

beforeEach(() => {
  jar.value = { beautyos_access: 'at', beautyos_refresh: 'rt' };
});
afterEach(() => vi.unstubAllGlobals());

describe('cambio de contraseña', () => {
  it('exige una contraseña nueva de al menos doce caracteres', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await change({ currentPassword: 'Antigua12345', newPassword: 'corta' });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rechaza la petición sin sesión antes de llamar a la API', async () => {
    jar.value = {};
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await change(valid)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('cierra la sesión al cambiarla para que los tokens viejos no sigan vivos', async () => {
    const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', upstream);
    const response = await change(valid);
    expect(response.status).toBe(200);
    expect(response.cookies.get('beautyos_access')?.value).toBe('');
    expect(response.cookies.get('beautyos_refresh')?.value).toBe('');
    expect(upstream.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer at',
    });
  });

  it('mantiene la sesión y explica el motivo cuando la actual no coincide', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ detail: 'La contraseña actual no coincide.' }, { status: 400 }),
      ),
    );
    const response = await change(valid);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: 'La contraseña actual no coincide.' });
    expect(response.cookies.get('beautyos_access')).toBeUndefined();
  });

  it('avisa de la caída sin dejar creer que la contraseña cambió', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const response = await change(valid);
    expect(response.status).toBe(503);
    expect(response.cookies.get('beautyos_access')).toBeUndefined();
  });
});
