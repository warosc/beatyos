import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id } = await context.params;
  const response = await fetch(
    `${API_URL}/clients/${encodeURIComponent(id)}/photos${request.nextUrl.search}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  return NextResponse.json(
    await response.json().catch(() => ({ message: 'Respuesta inválida.' })),
    { status: response.status },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id } = await context.params;
  // La subida es multipart: hay que reenviar el `Content-Type` original (trae el boundary) en
  // vez del `application/json` que usan el resto de proxys, y el cuerpo como stream. `duplex:
  // "half"` lo exige `fetch` de Node en cuanto el body es un `ReadableStream`.
  const contentType = request.headers.get('content-type') ?? undefined;
  const response = await fetch(`${API_URL}/clients/${encodeURIComponent(id)}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body: request.body,
    duplex: 'half',
    cache: 'no-store',
  } as RequestInit);
  return NextResponse.json(
    await response.json().catch(() => ({ message: 'Respuesta inválida.' })),
    { status: response.status },
  );
}
