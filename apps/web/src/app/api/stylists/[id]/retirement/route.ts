import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Qué impide dar de baja a una profesional: citas, comandas y turnos pendientes, y si su
 * acceso se desactivará (ADR-0027).
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id } = await context.params;
  const response = await fetch(`${API_URL}/stylists/${encodeURIComponent(id)}/retirement`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  return NextResponse.json(
    await response.json().catch(() => ({ message: 'Respuesta inválida.' })),
    { status: response.status },
  );
}
