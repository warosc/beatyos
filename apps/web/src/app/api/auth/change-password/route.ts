import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const schema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ message: 'Revisa las contraseñas ingresadas.' }, { status: 400 });
  const jar = await cookies();
  const token = jar.get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  const upstream = await fetch(`${API_URL}/auth/change-password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.data),
  }).catch(() => null);
  if (!upstream) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  if (!upstream.ok) {
    const problem = (await upstream.json().catch(() => null)) as {
      detail?: string;
      title?: string;
    } | null;
    return NextResponse.json(
      { message: problem?.detail ?? problem?.title ?? 'No pudimos cambiar la contraseña.' },
      { status: upstream.status },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('beautyos_access');
  response.cookies.delete('beautyos_refresh');
  return response;
}
