import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { apiRequest, ApiError } from '@/lib/api';
import { safeReturnPath } from '@/lib/safe-return-path';
import type { Session } from '@/lib/auth';

async function renew(redirectTo?: URL) {
  const jar = await cookies();
  const refreshToken = jar.get('beautyos_refresh')?.value;
  if (!refreshToken) return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  try {
    const session = await apiRequest<Session>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    const response = redirectTo
      ? NextResponse.redirect(redirectTo)
      : NextResponse.json({ user: session.user });
    const secure = process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production';
    response.cookies.set('beautyos_access', session.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: session.expiresIn,
    });
    response.cookies.set('beautyos_refresh', session.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 604800,
    });
    return response;
  } catch (error) {
    const response = redirectTo
      ? NextResponse.redirect(new URL('/login', redirectTo))
      : NextResponse.json(
          { message: 'Sesión expirada.' },
          { status: error instanceof ApiError ? error.status : 503 },
        );
    if (error instanceof ApiError && error.status === 401) {
      response.cookies.delete('beautyos_access');
      response.cookies.delete('beautyos_refresh');
    }
    return response;
  }
}

export async function POST() {
  return renew();
}
export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get('returnTo');
  const url = new URL('/session', request.url);
  url.searchParams.set('returnTo', safeReturnPath(returnTo));
  return NextResponse.redirect(url);
}
