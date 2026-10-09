import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Enlace del recordatorio. Público: quien lo abre es la clienta, sin cuenta. No lleva
 * cookie de sesión ni la mira; la API decide con el propio enlace.
 */
async function forward(token: string, path: string, method: 'GET' | 'POST', body?: string) {
  const response = await fetch(
    `${API_URL}/public/appointment-links/${encodeURIComponent(token)}${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
    },
  ).catch(() => null);
  if (!response) return NextResponse.json({ message: 'Servicio no disponible.' }, { status: 503 });
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return forward(token, '', 'GET');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const action = request.nextUrl.searchParams.get('action');
  if (action !== 'confirm' && action !== 'cancel')
    return NextResponse.json({ message: 'Acción no válida.' }, { status: 400 });
  return forward(token, `/${action}`, 'POST', (await request.text()) || '{}');
}
