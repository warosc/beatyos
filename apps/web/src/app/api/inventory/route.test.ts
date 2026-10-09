import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'access' }) }) }));
import { PATCH, POST } from './route';
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
it('envía la edición de un producto a PATCH /products/:id', async () => {
  const upstream = vi.fn(async () => Response.json({ data: { id: 'p' } }));
  vi.stubGlobal('fetch', upstream);
  const id = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
  const body = { name: 'Tinte rubio' };
  const response = await PATCH(
    new NextRequest(`http://localhost/api/inventory?resource=products&id=${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith(
    expect.stringMatching(new RegExp(`/api/v1/products/${id}$`)),
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify(body) }),
  );
});
it('no reenvía una edición sin un id de producto válido', async () => {
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  const response = await PATCH(
    new NextRequest('http://localhost/api/inventory?resource=products&id=../inventory/adjust', {
      method: 'PATCH',
      body: '{}',
    }),
  );
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
