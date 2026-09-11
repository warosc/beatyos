import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
// `action` se concatena a la ruta, y `fetch` normaliza `..` antes de salir: sin esta lista
// un `action=../../users` sacaría la petición del recurso de compras.
const ACTIONS = new Set(['submit', 'receive', 'cancel']);
async function token() {
  return (await cookies()).get('beautyos_access')?.value;
}
export async function GET(request: NextRequest) {
  const access = await token();
  if (!access) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource');
  const path =
    resource === 'suppliers' ? 'suppliers' : resource === 'products' ? 'products' : 'purchases';
  const response = await fetch(
    `${API}/${path}?${new URLSearchParams(Array.from(request.nextUrl.searchParams).filter(([key]) => ['page', 'limit', 'search', 'status'].includes(key)))}`,
    { headers: { Authorization: `Bearer ${access}` }, cache: 'no-store' },
  );
  return NextResponse.json(await response.json(), { status: response.status });
}
export async function POST(request: NextRequest) {
  const access = await token();
  if (!access) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource');
  const id = request.nextUrl.searchParams.get('id');
  const action = request.nextUrl.searchParams.get('action');
  if (action && !ACTIONS.has(action))
    return NextResponse.json({ message: 'Acción no válida.' }, { status: 400 });
  const path =
    resource === 'supplier'
      ? 'suppliers'
      : action && id
        ? `purchases/${encodeURIComponent(id)}/${action}`
        : 'purchases';
  const response = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: await request.text(),
    cache: 'no-store',
  });
  const body = await response.text();
  return new NextResponse(body || null, {
    status: response.status,
    headers: body
      ? { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }
      : undefined,
  });
}
