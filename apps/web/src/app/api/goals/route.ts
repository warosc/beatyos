import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

async function forward(request: NextRequest, method: 'GET' | 'POST') {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const query = method === 'GET' ? request.nextUrl.search : '';
  const response = await fetch(`${API_URL}/goals${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? await request.text() : undefined,
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({ message: 'Respuesta inválida del servicio.' }));
  return NextResponse.json(body, { status: response.status });
}

export const GET = (request: NextRequest) => forward(request, 'GET');
export const POST = (request: NextRequest) => forward(request, 'POST');
