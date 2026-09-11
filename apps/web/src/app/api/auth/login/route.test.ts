import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const session = {
  data: {
    accessToken: 'at',
    refreshToken: 'rt',
    tokenType: 'Bearer',
    expiresIn: 900,
    user: { id: 'u1', email: 'ana@example.com', roles: ['OWNER'] },
  },
};
const login = (body: unknown) =>
  POST(
    new Request('http://localhost/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  );
const credentials = { email: 'ana@example.com', password: 'Secreta12345' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('inicio de sesión', () => {
  it('rechaza credenciales mal formadas sin molestar a la API', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await login({ email: 'no-es-correo', password: 'x' });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('guarda la sesión en cookies httpOnly y no devuelve los tokens al navegador', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(session)),
    );
    const response = await login(credentials);
    expect(await response.json()).toEqual({ user: session.data.user });
    const cookie = response.cookies.get('beautyos_access');
    expect(cookie).toMatchObject({ value: 'at', httpOnly: true, sameSite: 'lax', path: '/' });
    expect(cookie?.maxAge).toBe(900);
    expect(response.cookies.get('beautyos_refresh')).toMatchObject({
      value: 'rt',
      httpOnly: true,
      sameSite: 'strict',
    });
  });

  it('marca las cookies como secure en producción', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(session)),
    );
    const response = await login(credentials);
    expect(response.cookies.get('beautyos_access')?.secure).toBe(true);
    expect(response.cookies.get('beautyos_refresh')?.secure).toBe(true);
  });

  it('no distingue correo inexistente de contraseña incorrecta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ detail: 'User ana@example.com not found' }, { status: 401 }),
      ),
    );
    const response = await login(credentials);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      message: 'El correo o la contraseña no son correctos.',
    });
  });

  it('no filtra el fallo de infraestructura cuando la API no responde', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed: ENOTFOUND api.interno');
      }),
    );
    const response = await login(credentials);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ message: 'El servicio no está disponible.' });
    expect(JSON.stringify(body)).not.toContain('ENOTFOUND');
  });

  it('deja pasar el mensaje de la API cuando no es un rechazo de credenciales', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Cuenta bloqueada.' }, { status: 423 })),
    );
    const response = await login(credentials);
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ message: 'Cuenta bloqueada.' });
  });
});
