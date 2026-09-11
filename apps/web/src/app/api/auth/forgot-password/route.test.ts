import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

let upstream: ReturnType<typeof vi.fn>;
const ask = (email: string) =>
  POST(
    new Request('http://localhost/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  );

beforeEach(() => {
  upstream = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('recuperación de contraseña', () => {
  it('funciona sin sesión y entrega la petición a la API', async () => {
    await ask('ana@example.com');
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/forgot-password$/);
    expect(JSON.parse(init.body as string)).toEqual({ email: 'ana@example.com' });
  });

  it('responde igual exista o no la cuenta, para no revelar el padrón', async () => {
    const conocida = await ask('ana@example.com');
    upstream.mockResolvedValue(new Response(null, { status: 202 }));
    const desconocida = await ask('nadie@example.com');
    expect([conocida.status, desconocida.status]).toEqual([202, 202]);
    expect(await conocida.text()).toBe(await desconocida.text());
  });

  it('avisa cuando el servicio no está disponible', async () => {
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    const response = await ask('ana@example.com');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'El servicio no está disponible.' });
  });
});
