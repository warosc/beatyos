import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const resources = {
  calendar: 'appointments/calendar',
  stylists: 'stylists',
  services: 'services',
  clients: 'clients',
  availability: 'appointments/availability',
} as const;

async function auth() {
  return (await cookies()).get('beautyos_access')?.value;
}
export async function GET(request: NextRequest) {
  const token = await auth();
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource') as keyof typeof resources;
  if (!resources[resource])
    return NextResponse.json({ message: 'Recurso inválido.' }, { status: 400 });
  const params = new URLSearchParams(request.nextUrl.searchParams);
  params.delete('resource');
  const response = await fetch(`${API_URL}/${resources[resource]}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  return NextResponse.json(await response.json(), { status: response.status });
}
export async function POST(request: NextRequest) {
  const token = await auth();
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const response = await fetch(`${API_URL}/appointments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
