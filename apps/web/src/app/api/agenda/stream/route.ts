import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

// Un flujo que dura lo que la pestaña esté abierta: ni caché ni prerenderizado.
export const dynamic = 'force-dynamic';

/**
 * Canal de avisos en vivo de la agenda.
 *
 * El navegador no puede mandar el token en la cabecera de un `EventSource`, y el token vive
 * en una cookie `httpOnly` que el JavaScript no ve: por eso el canal pasa por aquí, que lee
 * la cookie y abre el de la API con ella. El cuerpo se reenvía tal cual, sin almacenarlo.
 */
export async function GET(request: NextRequest) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });

  const upstream = await fetch(`${API_URL}/agenda/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    cache: 'no-store',
    signal: request.signal,
  }).catch(() => null);

  if (!upstream) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.json().catch(() => ({ message: 'No se pudo abrir el canal.' }));
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
