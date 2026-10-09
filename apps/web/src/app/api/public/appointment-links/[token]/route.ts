import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/** Forma del enlace: 18 bytes en base64url. Lo demás ni se reenvía. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Enlace del recordatorio. Público: quien lo abre es la clienta, sin cuenta. No lleva
 * cookie de sesión ni la mira; la API decide con el propio enlace.
 *
 * Reenvía la IP real: sin ella, la API cuenta los límites de peticiones de todas las
 * clientas como si vinieran del contenedor web, y unas cuantas peticiones de cualquiera
 * dejarían sin enlace a todas.
 */
async function forward(
  request: NextRequest,
  token: string,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
) {
  if (!TOKEN.test(token)) {
    return NextResponse.json({ message: 'Este enlace no es válido.' }, { status: 404 });
  }
  const forwardedFor = request.headers.get('x-forwarded-for');
  const response = await fetch(
    `${API_URL}/public/appointment-links/${encodeURIComponent(token)}${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      body,
      cache: 'no-store',
    },
  ).catch(() => null);
  if (!response) return NextResponse.json({ message: 'Servicio no disponible.' }, { status: 503 });
  const payload: unknown = await response
    .json()
    .catch(() => ({ message: 'Servicio no disponible.' }));
  return NextResponse.json(payload, { status: response.status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return forward(request, token, '', 'GET');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const action = request.nextUrl.searchParams.get('action');
  if (action !== 'confirm' && action !== 'cancel')
    return NextResponse.json({ message: 'Acción no válida.' }, { status: 400 });
  const body = await request.text();
  // Un motivo de cancelación cabe de sobra en 2 KB; más no es una clienta.
  if (body.length > 2048)
    return NextResponse.json({ message: 'Mensaje demasiado largo.' }, { status: 413 });
  return forward(request, token, `/${action}`, 'POST', body || '{}');
}
