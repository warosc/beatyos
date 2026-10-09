import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/** Bloquear un tramo de agenda (comida, formación…). */
export async function POST(request: NextRequest) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const response = await fetch(`${API_URL}/agenda/blocks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
