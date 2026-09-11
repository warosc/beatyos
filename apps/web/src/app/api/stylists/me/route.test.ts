import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.value[name] ? { value: jar.value[name] } : undefined),
  }),
}));
import { GET } from './route';

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  jar.value = { beautyos_access: 'at' };
  upstream = vi.fn(async () => Response.json({ data: { id: 's1', displayName: 'Sara' } }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

it('exige sesión', async () => {
  jar.value = {};
  expect((await GET()).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

it('consulta la ficha propia con el token de la sesión', async () => {
  const response = await GET();
  expect(upstream).toHaveBeenCalledWith(
    expect.stringMatching(/\/stylists\/me$/),
    expect.objectContaining({ headers: { Authorization: 'Bearer at' } }),
  );
  expect(await response.json()).toEqual({ data: { id: 's1', displayName: 'Sara' } });
});

it('deja pasar un null: la cuenta puede no tener ficha profesional', async () => {
  upstream.mockResolvedValue(Response.json({ data: null }));
  const response = await GET();
  expect(await response.json()).toEqual({ data: null });
});

it('no se rompe si la API contesta algo que no es JSON', async () => {
  upstream.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));
  const response = await GET();
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ message: 'Respuesta inválida.' });
});
