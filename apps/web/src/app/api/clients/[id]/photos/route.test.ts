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
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('galería de fotos de una clienta', () => {
  it('exige sesión en el listado', async () => {
    jar.value = {};
    const request = new NextRequest('http://localhost/api/clients/c1/photos');
    expect((await GET(request, context('c1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reenvía el querystring del listado', async () => {
    const request = new NextRequest('http://localhost/api/clients/c1/photos?kind=FORMULA&page=2');
    await GET(request, context('c1'));
    const url = calledUrl();
    expect(url.pathname).toMatch(/\/clients\/c1\/photos$/);
    expect(url.search).toBe('?kind=FORMULA&page=2');
    expect((upstream.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer at',
    });
  });

  it('exige sesión en la subida', async () => {
    jar.value = {};
    const request = new NextRequest('http://localhost/api/clients/c1/photos', { method: 'POST' });
    expect((await POST(request, context('c1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reenvía la subida como stream conservando el boundary multipart', async () => {
    const form = new FormData();
    form.append('file', new Blob(['fake'], { type: 'image/jpeg' }), 'formula.jpg');
    form.append('consentGivenAt', '2026-09-03T10:00:00.000Z');
    form.append('kind', 'FORMULA');
    const request = new NextRequest('http://localhost/api/clients/c1/photos', {
      method: 'POST',
      body: form,
    });
    const originalContentType = request.headers.get('content-type');
    upstream.mockResolvedValue(Response.json({ data: { id: 'photo-1' } }, { status: 201 }));

    const response = await POST(request, context('c1'));

    expect(response.status).toBe(201);
    expect(calledUrl().pathname).toMatch(/\/clients\/c1\/photos$/);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(originalContentType);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
    expect(init.body).toBeTruthy();
    expect((init as RequestInit & { duplex?: string }).duplex).toBe('half');
  });

  it('no se rompe si la API contesta algo que no es JSON', async () => {
    upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
    const request = new NextRequest('http://localhost/api/clients/c1/photos');
    const response = await GET(request, context('c1'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
  });
});
