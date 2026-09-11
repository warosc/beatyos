import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

let upstream: ReturnType<typeof vi.fn>;
const reset = (body: unknown) =>
  POST(
    new Request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  upstream = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('nueva contraseña con token de un solo uso', () => {
  it('entrega token y contraseña a la API sin exigir sesión', async () => {
    await reset({ token: 't1', password: 'NuevaSegura12345' });
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      token: 't1',
      password: 'NuevaSegura12345',
    });
  });

  it('devuelve el 204 de la API sin intentar darle cuerpo', async () => {
    const response = await reset({ token: 't1', password: 'NuevaSegura12345' });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('deja pasar el rechazo de un token gastado', async () => {
    upstream.mockResolvedValue(Response.json({ detail: 'Token inválido.' }, { status: 400 }));
    const response = await reset({ token: 'usado', password: 'NuevaSegura12345' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: 'Token inválido.' });
  });

  it('avisa cuando el servicio no está disponible', async () => {
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    expect((await reset({ token: 't1', password: 'x' })).status).toBe(503);
  });
});
