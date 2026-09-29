import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { POST } from './route';

let upstream: ReturnType<typeof vi.fn>;
const context = (id: string, action: string) => ({ params: Promise.resolve({ id, action }) });
const request = (body: string) =>
  new NextRequest('http://localhost/api/service-tickets/t1/charge', { method: 'POST', body });

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { ticketId: 't1' } }, { status: 201 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('acciones sobre una comanda', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await POST(request('{}'), context('t1', 'charge'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('solo reenvía cobrar y anular', async () => {
    expect((await POST(request('{}'), context('t1', 'delete'))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reenvía el cobro con el token y el cuerpo tal cual', async () => {
    const body = JSON.stringify({ payments: [{ method: 'CASH', amount: 112 }] });
    const response = await POST(request(body), context('t1', 'charge'));

    expect(response.status).toBe(201);
    const url = new URL(upstream.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(/\/service-tickets\/t1\/charge$/);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
    expect(init.body).toBe(body);
  });
});
