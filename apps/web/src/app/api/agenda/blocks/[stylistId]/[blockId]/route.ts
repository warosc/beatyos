import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ stylistId: string; blockId: string }> },
) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const { stylistId, blockId } = await params;
  const response = await fetch(
    `${API_URL}/agenda/blocks/${encodeURIComponent(stylistId)}/${encodeURIComponent(blockId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 204) return new NextResponse(null, { status: 204 });
  return NextResponse.json(await response.json(), { status: response.status });
}
