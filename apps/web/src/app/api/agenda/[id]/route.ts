import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const ACTIONS = new Set(['confirm', 'start', 'complete', 'cancel', 'no-show']);
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id } = await params;
  // Solo estas acciones; cualquier otra cosa se trata como reprogramar, que valida su cuerpo.
  const requested = request.nextUrl.searchParams.get('action') ?? '';
  const action = ACTIONS.has(requested) ? requested : 'reschedule';
  const response = await fetch(`${API_URL}/appointments/${encodeURIComponent(id)}/${action}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
