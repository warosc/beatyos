import { NextRequest, NextResponse } from 'next/server';
import { DISPLAY_TOKEN } from '../token';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Pantalla de turnos de la sala. Pública: la abre una TV sin cuenta. No lleva cookie de
 * sesión ni la mira; la API decide con el propio enlace.
 *
 * Reenvía la IP real, como el enlace de la cita: sin ella la API contaría los límites de
 * todas las pantallas como si vinieran del contenedor web.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!DISPLAY_TOKEN.test(token))
    return NextResponse.json({ message: 'Este enlace no es válido.' }, { status: 404 });
  const forwardedFor = request.headers.get('x-forwarded-for');
  const response = await fetch(`${API_URL}/public/queue-display/${encodeURIComponent(token)}`, {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    cache: 'no-store',
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: 'Servicio no disponible.' }, { status: 503 });
  const payload: unknown = await response
    .json()
    .catch(() => ({ message: 'Servicio no disponible.' }));
  return NextResponse.json(payload, { status: response.status });
}
