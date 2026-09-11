import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

async function forward(request: NextRequest, method: 'GET' | 'POST') {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const query = method === 'GET' ? request.nextUrl.search : '';
  const response = await fetch(`${API_URL}/clients${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? await request.text() : undefined,
    cache: 'no-store',
  });
  // `NextResponse.json` no puede construir un 204: la respuesta sin cuerpo hay que
  // devolverla tal cual, como ya hace `clients/[id]` con el borrado.
  if (response.status === 204) return new NextResponse(null, { status: 204 });
  const body = await response.json().catch(() => ({ message: 'Respuesta inválida del servicio.' }));
  return NextResponse.json(body, { status: response.status });
}

export const GET = (request: NextRequest) => forward(request, 'GET');
export const POST = (request: NextRequest) => forward(request, 'POST');
