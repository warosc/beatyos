import { NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function POST(request: Request) {
  const response = await fetch(`${API}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
