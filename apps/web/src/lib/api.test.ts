import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('contrato de la API', () => {
  it('desenvuelve la envoltura data de un recurso simple', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: { id: 'c1' } })),
    );
    await expect(apiRequest('/clients/c1')).resolves.toEqual({ id: 'c1' });
  });

  it('conserva data y meta juntas para que la paginación no se pierda', async () => {
    const page = { data: [{ id: 'c1' }], meta: { page: 1, total: 1 } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(page)),
    );
    await expect(apiRequest('/clients')).resolves.toEqual(page);
  });

  it('traduce el problem detail en el mensaje del error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'La caja ya está abierta.' }, { status: 409 })),
    );
    await expect(apiRequest('/cash/open', { method: 'POST' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'La caja ya está abierta.',
    });
  });

  it('recurre al título y luego a un mensaje neutro cuando no hay detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ title: 'Conflicto' }, { status: 409 })),
    );
    await expect(apiRequest('/cash/open')).rejects.toThrow('Conflicto');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    await expect(apiRequest('/cash/open')).rejects.toThrow('No pudimos completar la solicitud.');
  });

  it('no sirve una escritura desde la caché', async () => {
    const upstream = vi.fn(async () => Response.json({ data: true }));
    vi.stubGlobal('fetch', upstream);
    await apiRequest('/auth/login', { method: 'POST', body: '{}' });
    expect(upstream).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/login$/),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('expone el estado para que quien llama distinga credenciales de caída', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'no' }, { status: 401 })),
    );
    const error = await apiRequest('/auth/login').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });
});
