import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Reenvía una petición de la fila a la API con el token de la sesión.
 *
 * Las rutas de la fila son varias y todas iguales: leen la cookie, llaman y devuelven tal
 * cual. Juntarlo aquí evita que una de ellas olvide el `no-store` o el 503 de API caída.
 */
export async function forwardToQueue(path: string, method: 'GET' | 'POST', body?: string) {
  const token = (await cookies()).get('beautyos_access')?.value;
  if (!token) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const response = await fetch(`${API_URL}/queue${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? body || '{}' : undefined,
    cache: 'no-store',
  }).catch(() => null);
  if (!response) return NextResponse.json({ message: 'API no disponible.' }, { status: 503 });
  const payload: unknown = await response
    .json()
    .catch(() => ({ message: 'Respuesta inválida del servicio.' }));
  return NextResponse.json(payload, { status: response.status });
}
