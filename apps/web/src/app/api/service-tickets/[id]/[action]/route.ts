import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const ACTIONS = new Set(['charge', 'cancel']);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; action: string }> },
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const { id, action } = await context.params;
  if (!ACTIONS.has(action))
    return NextResponse.json({ message: 'Acción inválida.' }, { status: 400 });
  const response = await fetch(`${API_URL}/service-tickets/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await request.text(),
    cache: 'no-store',
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  const body = await response.json().catch(() => ({ message: 'Respuesta inválida del servicio.' }));
  return NextResponse.json(body, { status: response.status });
}
