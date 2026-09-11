import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
export async function GET(request: NextRequest) {
  const t = (await cookies()).get('beautyos_access')?.value;
  if (!t) return NextResponse.json({ message: 'Sesión expirada' }, { status: 401 });
  const r = await fetch(`${API}/sales${request.nextUrl.search}`, {
    headers: { Authorization: `Bearer ${t}` },
    cache: 'no-store',
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
export async function POST(q: NextRequest) {
  const t = (await cookies()).get('beautyos_access')?.value;
  if (!t) return NextResponse.json({ message: 'Sesión expirada' }, { status: 401 });
  const r = await fetch(`${API}/sales`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: await q.text(),
  });
  return NextResponse.json(await r.json(), { status: r.status });
}
