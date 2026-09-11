import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

export async function POST() {
  const jar = await cookies();
  const accessToken = jar.get('beautyos_access')?.value;
  const refreshToken = jar.get('beautyos_refresh')?.value;
  if (refreshToken)
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => null);
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('beautyos_access');
  response.cookies.delete('beautyos_refresh');
  return response;
}
