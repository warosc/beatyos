import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string; timeOffId: string }> },
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { id, timeOffId } = await context.params;
  const response = await fetch(
    `${API}/stylists/${encodeURIComponent(id)}/time-off/${encodeURIComponent(timeOffId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
  );
  const body = await response.text();
  return new NextResponse(body || null, {
    status: response.status,
    headers: body
      ? { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }
      : undefined,
  });
}
