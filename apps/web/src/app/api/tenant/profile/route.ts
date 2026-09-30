import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/** Datos del salón para comprobantes: los lee quien cobra y los cambia quien administra. */
async function forward(method: 'GET' | 'PATCH', request?: NextRequest) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const response = await fetch(`${API_URL}/tenant/profile`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: request ? await request.text() : undefined,
    cache: 'no-store',
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  const body = await response.json().catch(() => ({ message: 'Respuesta inválida del servicio.' }));
  return NextResponse.json(body, { status: response.status });
}

export const GET = () => forward('GET');
export const PATCH = (request: NextRequest) => forward('PATCH', request);
