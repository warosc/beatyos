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

// El enlace del recordatorio lo abre la clienta, que no tiene cuenta: la página y su ruta de
// servidor no pasan por la sesión. La API decide con el propio enlace.
const PUBLIC_PREFIXES = ['/cita/', '/api/public/'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic =
    PUBLIC_PATHS.some((path) => pathname === path) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const authenticated = request.cookies.has('beautyos_access');
  const canRefresh = request.cookies.has('beautyos_refresh');
  if (!authenticated && !isPublic && pathname.startsWith('/api/'))
    return NextResponse.json({ message: 'Sesión expirada.' }, { status: 401 });
  if (!authenticated && canRefresh && !isPublic) {
    const refreshUrl = new URL('/session', request.url);
    refreshUrl.searchParams.set('returnTo', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(refreshUrl);
  }
  if (!authenticated && !isPublic) return NextResponse.redirect(new URL('/login', request.url));
  return NextResponse.next();
}

// Los archivos de metadatos de Next (`favicon.ico`, `icon.svg`, y cualquier `apple-icon` u
// `opengraph-image` que se anada despues) se sirven desde la raiz y el navegador los pide sin
// pasar por la pantalla de login. Si el proxy los redirige, no falla nada de forma visible:
// la pestana se queda sin icono y solo se nota mirando la consola. Todo metadato nuevo tiene
// que sumarse aqui. El manifiesto, el service worker y los iconos de la app instalable,
// tambien: el navegador los pide antes de que haya sesion.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|icons/).*)',
  ],
};
