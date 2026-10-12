import { NextRequest, NextResponse } from 'next/server';
import { DISPLAY_TOKEN } from '../../token';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

// Un flujo que dura lo que la pantalla esté encendida: ni caché ni prerenderizado.
export const dynamic = 'force-dynamic';

/**
 * Canal de avisos de la pantalla. Igual que el de la agenda, pero sin sesión: la credencial
 * es el enlace. El cuerpo se reenvía tal cual, sin almacenarlo.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!DISPLAY_TOKEN.test(token))
    return NextResponse.json({ message: 'Este enlace no es válido.' }, { status: 404 });
  const forwardedFor = request.headers.get('x-forwarded-for');

  const upstream = await fetch(
    `${API_URL}/public/queue-display/${encodeURIComponent(token)}/stream`,
    {
      headers: {
        Accept: 'text/event-stream',
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      cache: 'no-store',
      signal: request.signal,
    },
  ).catch(() => null);

  if (!upstream) return NextResponse.json({ message: 'Servicio no disponible.' }, { status: 503 });
  if (!upstream.ok || !upstream.body) {
    const body: unknown = await upstream
      .json()
      .catch(() => ({ message: 'No se pudo abrir el canal.' }));
    return NextResponse.json(body, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
