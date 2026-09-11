import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from './proxy';

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
const access = 'beautyos_access=at';
const refresh = 'beautyos_refresh=rt';

describe('puerta de sesión', () => {
  it.each(['/login', '/forgot-password', '/reset-password', '/session', '/api/auth/login'])(
    'deja pasar %s sin sesión',
    (path) => expect(proxy(request(path)).headers.get('location')).toBeNull(),
  );

  it('deja pasar cualquier página con una sesión válida', () => {
    expect(proxy(request('/caja', access)).headers.get('location')).toBeNull();
  });

  it('responde 401 en la API en vez de mandar HTML de login a un fetch', async () => {
    const response = proxy(request('/api/clients'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('json');
    expect(await response.json()).toEqual({ message: 'Sesión expirada.' });
  });

  it('manda a /session con el destino cuando solo caducó el acceso', () => {
    const location = proxy(request('/clientes?search=Ana', refresh)).headers.get('location');
    expect(new URL(location!).pathname).toBe('/session');
    expect(new URL(location!).searchParams.get('returnTo')).toBe('/clientes?search=Ana');
  });

  it('manda al login cuando no queda nada que renovar', () => {
    const location = proxy(request('/inventario')).headers.get('location');
    expect(new URL(location!).pathname).toBe('/login');
  });

  it('prefiere renovar antes que pedir la contraseña otra vez', () => {
    const location = proxy(request('/agenda', `${refresh}; otra=1`)).headers.get('location');
    expect(new URL(location!).pathname).toBe('/session');
  });

  it('no intercepta los metadatos que el navegador pide sin sesión', () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const asset of ['/favicon.ico', '/icon.svg', '/_next/static/chunk.js'])
      expect(matcher.test(asset)).toBe(false);
    expect(matcher.test('/caja')).toBe(true);
  });
});
