import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
async function forward(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
  method: 'GET' | 'PATCH' | 'DELETE',
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id } = await context.params;
  const response = await fetch(`${API_URL}/clients/${encodeURIComponent(id)}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'PATCH' ? await request.text() : undefined,
    cache: 'no-store',
  });
  if (response.status === 204) return new NextResponse(null, { status: 204 });
  return NextResponse.json(
    await response.json().catch(() => ({ message: 'Respuesta inválida.' })),
    { status: response.status },
  );
}
export const GET = (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
  forward(request, context, 'GET');
export const PATCH = (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
  forward(request, context, 'PATCH');
export const DELETE = (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
  forward(request, context, 'DELETE');
