import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

let upstream: ReturnType<typeof vi.fn>;
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const context = (token: string) => ({ params: Promise.resolve({ token }) });
const request = (headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/public/queue-display/${TOKEN}`, { headers });

beforeEach(() => {
  upstream = vi.fn(async () => Response.json({ data: { salonName: 'Marian' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('pantalla de turnos (pública)', () => {
  it('un enlace con otra forma ni se reenvía', async () => {
    expect((await GET(request(), context('../../users'))).status).toBe(404);
    expect((await GET(request(), context('corto'))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reenvía sin sesión y con la IP real de la pantalla', async () => {
    const response = await GET(request({ 'x-forwarded-for': '203.0.113.7' }), context(TOKEN));

    expect(response.status).toBe(200);
    const url = new URL(upstream.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(new RegExp(`/public/queue-display/${TOKEN}$`));
    const headers = (upstream.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers.Authorization).toBeUndefined();
  });

  it('devuelve el 404 de la API cuando el enlace se retiró', async () => {
    upstream.mockResolvedValueOnce(Response.json({ detail: 'No válido' }, { status: 404 }));
    expect((await GET(request(), context(TOKEN))).status).toBe(404);
  });
});
