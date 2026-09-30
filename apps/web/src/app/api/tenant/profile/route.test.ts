import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'at' }) }) }));
import { GET, PATCH } from './route';

afterEach(() => vi.unstubAllGlobals());

it('lee y modifica los datos del salón en la API', async () => {
  const upstream = vi.fn(async () => Response.json({ data: { name: 'Salón' } }));
  vi.stubGlobal('fetch', upstream);

  await GET();
  expect(upstream).toHaveBeenLastCalledWith(
    expect.stringMatching(/\/tenant\/profile$/),
    expect.objectContaining({ method: 'GET' }),
  );

  const body = JSON.stringify({ taxId: '1234567-8' });
  await PATCH(new NextRequest('http://localhost/api/tenant/profile', { method: 'PATCH', body }));
  expect(upstream).toHaveBeenLastCalledWith(
    expect.stringMatching(/\/tenant\/profile$/),
    expect.objectContaining({ method: 'PATCH', body }),
  );
});
