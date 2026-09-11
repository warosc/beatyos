import { NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function POST(request: Request) {
  const response = await fetch(`${API}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
    cache: 'no-store',
  }).catch(() => null);
  if (!response)
    return NextResponse.json({ message: 'El servicio no está disponible.' }, { status: 503 });
  const body = await response.text();
  return new NextResponse(body || null, {
    status: response.status,
    headers: body
      ? { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }
      : undefined,
  });
}
