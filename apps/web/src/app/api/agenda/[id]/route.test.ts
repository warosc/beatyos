import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { PATCH } from './route';

let upstream: ReturnType<typeof vi.fn>;
const patch = (id: string, query = '') =>
  PATCH(
    new NextRequest(`http://localhost/api/agenda/${encodeURIComponent(id)}?${query}`, {
      method: 'PATCH',
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
const calledUrl = () => new URL(upstream.mock.calls[0][0] as string);

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: {} }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('cambios sobre una cita', () => {
  it('exige sesión', async () => {
    jar.value = {};
    expect((await patch('a1')).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('cancela cuando se pide explícitamente', async () => {
    await patch('a1', 'action=cancel');
    expect(calledUrl().pathname).toMatch(/\/appointments\/a1\/cancel$/);
  });

  it.each(['', 'action=reschedule', 'action=delete'])(
    'reprograma en cualquier otro caso (%s)',
    async (query) => {
      await patch('a1', query);
      expect(calledUrl().pathname).toMatch(/\/appointments\/a1\/reschedule$/);
    },
  );

  it('codifica el identificador para no salirse del recurso', async () => {
    await patch('a/1', 'action=cancel');
    expect(calledUrl().pathname).toMatch(/\/appointments\/a%2F1\/cancel$/);
  });
});
