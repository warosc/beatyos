import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/** Detalle de una venta con sus cobros: lo que se reimprime y lo que se anula. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const { id } = await context.params;
  const response = await fetch(`${API_URL}/sales/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  const body = await response.json().catch(() => ({ message: 'Respuesta inválida del servicio.' }));
  return NextResponse.json(body, { status: response.status });
}
