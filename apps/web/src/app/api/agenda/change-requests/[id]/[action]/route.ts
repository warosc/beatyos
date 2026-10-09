import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

const ACTIONS = new Set(['approve', 'reject', 'withdraw']);

/** Decidir sobre un cambio de hora: la encargada aprueba o rechaza; la profesional lo retira. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id, action } = await params;
  if (!ACTIONS.has(action))
    return NextResponse.json({ message: 'Acción no válida.' }, { status: 400 });
  const response = await fetch(
    `${API_URL}/agenda/change-requests/${encodeURIComponent(id)}/${action}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: (await request.text()) || '{}',
    },
  );
  return NextResponse.json(await response.json(), { status: response.status });
}
