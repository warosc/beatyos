import { NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function POST(request: Request) {
  // Cada solicitud deja un aviso a la propietaria: el límite por IP de la API tiene que
  // contar la de quien la pide, no la de este servidor, que es la misma para todos.
  const forwardedFor = request.headers.get('x-forwarded-for');
  const response = await fetch(`${API}/auth/forgot-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: await request.text(),
    cache: 'no-store',
  }).catch(() => null);
  if (!response)
    return NextResponse.json({ message: 'El servicio no está disponible.' }, { status: 503 });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  });
}
