import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRequest, ApiError } from '@/lib/api';
import type { Session } from '@/lib/auth';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ message: 'Revisa el correo y la contraseña.' }, { status: 400 });
  try {
    const session = await apiRequest<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    });
    const response = NextResponse.json({ user: session.user });
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
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (error) {
    // Solo un `ApiError` trae un mensaje pensado para quien está mirando la pantalla: sale
    // del `detail` de la respuesta de la API. Cualquier otra excepción es de infraestructura
    // —la API caída da `fetch failed`, un DNS roto da `ENOTFOUND`— y enseñarla no ayuda a
    // nadie a entrar mientras describe el despliegue a quien no debería verlo.
    if (!(error instanceof ApiError))
      return NextResponse.json({ message: 'El servicio no está disponible.' }, { status: 503 });
    const message =
      error.status === 401 ? 'El correo o la contraseña no son correctos.' : error.message;
    return NextResponse.json({ message }, { status: error.status });
  }
}
