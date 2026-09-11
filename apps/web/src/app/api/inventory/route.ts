import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const paths = {
  products: 'products',
  kardex: 'inventory/kardex',
  batches: 'inventory/batches',
  receive: 'inventory/receive',
  adjust: 'inventory/adjust',
} as const;
async function forward(request: NextRequest, method: 'GET' | 'POST') {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource') as keyof typeof paths;
  if (!paths[resource]) return NextResponse.json({ message: 'Recurso inválido.' }, { status: 400 });
  const query = new URLSearchParams(request.nextUrl.searchParams);
  query.delete('resource');
  const response = await fetch(
    `${API_URL}/${paths[resource]}${method === 'GET' ? `?${query}` : ''}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? await request.text() : undefined,
      cache: 'no-store',
    },
  );
  return NextResponse.json(await response.json(), { status: response.status });
}
export const GET = (r: NextRequest) => forward(r, 'GET');
export const POST = (r: NextRequest) => forward(r, 'POST');
