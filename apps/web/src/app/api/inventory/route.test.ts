import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'access' }) }) }));
import { POST } from './route';
afterEach(() => vi.unstubAllGlobals());
it('envía el alta de products a POST /products conservando el contrato', async () => {
  const upstream = vi.fn(async () => Response.json({ data: { id: 'p' } }, { status: 201 }));
  vi.stubGlobal('fetch', upstream);
  const body = { sku: 'P', name: 'Tinte', price: 10 };
  const response = await POST(
    new NextRequest('http://localhost/api/inventory?resource=products', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(201);
  expect(upstream).toHaveBeenCalledWith(
    expect.stringMatching(/\/api\/v1\/products$/),
    expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
  );
});
