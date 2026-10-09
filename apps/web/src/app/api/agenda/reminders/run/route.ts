import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/** Envía ya los recordatorios pendientes del salón, sin esperar a la siguiente pasada. */
export async function POST() {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const response = await fetch(`${API_URL}/agenda/reminders/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
