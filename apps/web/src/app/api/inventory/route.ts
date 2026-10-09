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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function forward(request: NextRequest, method: 'GET' | 'POST' | 'PATCH') {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource') as keyof typeof paths;
  if (!paths[resource]) return NextResponse.json({ message: 'Recurso inválido.' }, { status: 400 });
  // Solo se edita un producto concreto: el id va en la ruta de la API, así que se valida aquí.
  const id = request.nextUrl.searchParams.get('id');
  if (method === 'PATCH' && (resource !== 'products' || !id || !UUID.test(id))) {
    return NextResponse.json({ message: 'Producto inválido.' }, { status: 400 });
  }
  const query = new URLSearchParams(request.nextUrl.searchParams);
  query.delete('resource');
  const target = method === 'PATCH' ? `${paths[resource]}/${id}` : paths[resource];
  const response = await fetch(`${API_URL}/${target}${method === 'GET' ? `?${query}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : await request.text(),
    cache: 'no-store',
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
export const GET = (r: NextRequest) => forward(r, 'GET');
export const POST = (r: NextRequest) => forward(r, 'POST');
export const PATCH = (r: NextRequest) => forward(r, 'PATCH');
