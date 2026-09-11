import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function GET(request: NextRequest) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource');
  if (resource !== 'executive' && resource !== 'dashboard')
    return NextResponse.json({ message: 'Recurso inválido' }, { status: 400 });
  const params = new URLSearchParams(request.nextUrl.searchParams);
  params.delete('resource');
  const response = await fetch(`${API}/reports/${resource}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
