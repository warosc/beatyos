import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionFetch } from './session-fetch';

afterEach(() => vi.unstubAllGlobals());
describe('sesiones concurrentes', () => {
  it('renueva una sola vez y reintenta cada petición rechazada', async () => {
    let refreshed = false;
    let rotations = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/refresh') {
          rotations++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          refreshed = true;
          return Response.json({ ok: true });
        }
        return Response.json({}, { status: refreshed ? 200 : 401 });
      }),
    );
    const responses = await Promise.all([
      sessionFetch('/api/clients'),
      sessionFetch('/api/inventory'),
      sessionFetch('/api/cash'),
    ]);
    expect(rotations).toBe(1);
    expect(responses.every((r) => r.ok)).toBe(true);
  });
  it('renueva el token ante un 403 por permisos antiguos y repite una sola vez', async () => {
    let renewed = false;
    const request = vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') {
        renewed = true;
        return Response.json({ ok: true });
      }
      return Response.json({}, { status: renewed ? 201 : 403 });
    });
    vi.stubGlobal('fetch', request);
    const result = await sessionFetch('/api/sales', { method: 'POST', body: '{}' });
    expect(result.status).toBe(201);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/sales',
      '/api/auth/refresh',
      '/api/sales',
    ]);
  });
  it('devuelve el 403 si tras renovar sigue sin permiso', async () => {
    const request = vi.fn(async (url: string) =>
      url === '/api/auth/refresh'
        ? Response.json({ ok: true })
        : Response.json({}, { status: 403 }),
    );
    vi.stubGlobal('fetch', request);
    expect((await sessionFetch('/api/sales', { method: 'POST', body: '{}' })).status).toBe(403);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('no renueva ni reintenta una contraseña incorrecta', async () => {
    const request = vi.fn(async () => Response.json({}, { status: 401 }));
    vi.stubGlobal('fetch', request);
    expect((await sessionFetch('/api/auth/login', { method: 'POST' })).status).toBe(401);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('no repite una escritura cuyo resultado de red es desconocido', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', request);
    const result = await sessionFetch('/api/sales', { method: 'POST', body: '{}' });
    expect(result.status).toBe(503);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
