import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = [
  '/session',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/api/auth/login',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/refresh',
  '/api/auth/logout',
];

export function proxy(request: NextRequest) {
  const isPublic = PUBLIC_PATHS.some((path) => request.nextUrl.pathname === path);
  const authenticated = request.cookies.has('beautyos_access');
  const canRefresh = request.cookies.has('beautyos_refresh');
  if (!authenticated && !isPublic && request.nextUrl.pathname.startsWith('/api/'))
    return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  if (!authenticated && canRefresh && !isPublic) {
    const refreshUrl = new URL('/session', request.url);
    refreshUrl.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(refreshUrl);
  }
  if (!authenticated && !isPublic) return NextResponse.redirect(new URL('/login', request.url));
  return NextResponse.next();
}

// Los archivos de metadatos de Next (`favicon.ico`, `icon.svg`, y cualquier `apple-icon` u
// `opengraph-image` que se anada despues) se sirven desde la raiz y el navegador los pide sin
// pasar por la pantalla de login. Si el proxy los redirige, no falla nada de forma visible:
// la pestana se queda sin icono y solo se nota mirando la consola. Todo metadato nuevo tiene
// que sumarse aqui.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'] };
