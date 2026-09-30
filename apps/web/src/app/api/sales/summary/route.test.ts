import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'at' }) }) }));
import { GET } from './route';

afterEach(() => vi.unstubAllGlobals());

it('reenvía solo el rango del cuadre', async () => {
  const upstream: ReturnType<typeof vi.fn> = vi.fn(async () => Response.json({ data: {} }));
  vi.stubGlobal('fetch', upstream);
  await GET(
    new NextRequest('http://localhost/api/sales/summary?from=2026-09-30&to=2026-10-01&extra=1'),
  );
  const called = new URL(upstream.mock.calls[0][0] as string);
  expect(called.pathname).toMatch(/\/sales\/summary$/);
  expect(Object.fromEntries(called.searchParams)).toEqual({ from: '2026-09-30', to: '2026-10-01' });
});
