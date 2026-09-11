import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id } = await params;
  const action = request.nextUrl.searchParams.get('action') === 'cancel' ? 'cancel' : 'reschedule';
  const response = await fetch(`${API_URL}/appointments/${encodeURIComponent(id)}/${action}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
