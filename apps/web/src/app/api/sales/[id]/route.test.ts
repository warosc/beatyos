import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { GET } from './route';
import { POST } from './void/route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const voidRequest = (body: string) =>
  new NextRequest('http://localhost/api/sales/s1/void', { method: 'POST', body });

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 's1' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('una venta', () => {
  it('exige sesión para ver y para anular', async () => {
    jar.value = {};
    const detail = await GET(new NextRequest('http://localhost/api/sales/s1'), context('s1'));
    expect(detail.status).toBe(401);
    expect((await POST(voidRequest('{}'), context('s1'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('consulta el detalle y anula con el motivo', async () => {
    await GET(new NextRequest('http://localhost/api/sales/s1'), context('s1'));
    expect(upstream.mock.calls[0][0]).toMatch(/\/api\/v1\/sales\/s1$/);

    const body = JSON.stringify({ reason: 'Cobrada por error' });
    await POST(voidRequest(body), context('s1'));
    expect(upstream).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/v1\/sales\/s1\/void$/),
      expect.objectContaining({ method: 'POST', body }),
    );
  });

  it('no deja que el identificador cambie la ruta de la API', async () => {
    await GET(new NextRequest('http://localhost/api/sales/x'), context('../users'));
    expect(upstream.mock.calls[0][0]).toMatch(/\/sales\/\.\.%2Fusers$/);
  });
});
