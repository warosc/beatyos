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
  new NextRequest('http://localhost/api/queue/t1/finish', { method: 'POST', body });

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 't1' } }, { status: 200 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('acciones sobre un turno de la fila', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await POST(request('{}'), context('t1', 'start'))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('solo reenvía las acciones de la fila', async () => {
    expect((await POST(request('{}'), context('t1', 'delete'))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['call', 'recall', 'start', 'no-show', 'requeue', 'cancel', 'finish'])(
    'reenvía %s con el token y el cuerpo tal cual',
    async (action) => {
      const body = JSON.stringify({ serviceIds: ['s1'] });
      const response = await POST(request(body), context('t1', action));

      expect(response.status).toBe(200);
      const url = new URL(upstream.mock.calls[0][0] as string);
      expect(url.pathname).toMatch(new RegExp(`/queue/t1/${action}$`));
      const init = upstream.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
      expect(init.body).toBe(body);
    },
  );

  it('un cuerpo vacío viaja como objeto vacío', async () => {
    await POST(request(''), context('t1', 'recall'));
    expect((upstream.mock.calls[0][1] as RequestInit).body).toBe('{}');
  });

  it('con la API caída responde 503', async () => {
    upstream.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await POST(request('{}'), context('t1', 'start'))).status).toBe(503);
  });
});
