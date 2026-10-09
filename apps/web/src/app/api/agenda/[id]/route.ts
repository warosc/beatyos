import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

// Lista cerrada: el nombre de la acción acaba en la URL de la API y no puede venir libre.
const PATCH_ACTIONS = new Set(['cancel', 'start', 'confirm', 'complete', 'no-show', 'notes']);
const POST_ACTIONS: Record<string, string> = {
  'change-request': 'change-requests',
  reminder: 'reminder',
};

async function forward(request: NextRequest, id: string, path: string, method: 'PATCH' | 'POST') {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const response = await fetch(`${API_URL}/appointments/${encodeURIComponent(id)}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Cualquier otra cosa se trata como reprogramar, que valida su cuerpo.
  const requested = request.nextUrl.searchParams.get('action') ?? '';
  const action = PATCH_ACTIONS.has(requested) ? requested : 'reschedule';
  return forward(request, id, action, 'PATCH');
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const action = POST_ACTIONS[request.nextUrl.searchParams.get('action') ?? ''];
  if (!action) return NextResponse.json({ message: 'Acción no válida.' }, { status: 400 });
  return forward(request, id, action, 'POST');
}
