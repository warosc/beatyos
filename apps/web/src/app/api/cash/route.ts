import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const paths = {
  current: 'cash/current',
  history: 'cash/history',
  open: 'cash/open',
  movement: 'cash/movements',
  close: 'cash/close',
} as const;
async function go(r: NextRequest, m: 'GET' | 'POST') {
  const t = (await cookies()).get('beautyos_access')?.value;
  if (!t) return NextResponse.json({ message: 'Sesión expirada' }, { status: 401 });
  const k = r.nextUrl.searchParams.get('resource') as keyof typeof paths;
  if (!paths[k]) return NextResponse.json({ message: 'Recurso inválido' }, { status: 400 });
  const u = await fetch(
    `${API}/${paths[k]}${m === 'GET' ? '?' + new URLSearchParams(Array.from(r.nextUrl.searchParams).filter(([key]) => ['page', 'limit'].includes(key))) : ''}`,
    {
      method: m,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: m === 'POST' ? await r.text() : undefined,
      cache: 'no-store',
    },
  );
  return NextResponse.json(await u.json(), { status: u.status });
}
export const GET = (r: NextRequest) => go(r, 'GET');
export const POST = (r: NextRequest) => go(r, 'POST');
