import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const resources = new Set(['users', 'roles', 'permissions']);

async function forward(request: NextRequest, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') {
  const access = (await cookies()).get('beautyos_access')?.value;
  if (!access) return NextResponse.json({ message: 'Tu sesión ha expirado.' }, { status: 401 });
  const resource = request.nextUrl.searchParams.get('resource') ?? '';
  const id = request.nextUrl.searchParams.get('id');
  const action = request.nextUrl.searchParams.get('action');
  if (!resources.has(resource))
    return NextResponse.json({ message: 'Recurso no válido.' }, { status: 400 });
  let path = resource === 'permissions' ? 'roles/permissions' : resource;
  if (id) path += `/${encodeURIComponent(id)}`;
  if (action === 'roles' && id) path += '/roles';
  if (action === 'restore' && id) path += '/restore';
  const query =
    method === 'GET' && resource === 'users'
      ? request.nextUrl.searchParams
          .toString()
          .replace(/(^|&)resource=users(&|$)/, '$1')
          .replace(/^&|&$/g, '')
      : '';
  const response = await fetch(`${API}/${path}${query ? `?${query}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: ['POST', 'PATCH', 'PUT'].includes(method) ? await request.text() : undefined,
    cache: 'no-store',
  });
  const body = await response.text();
  return new NextResponse(body || null, {
    status: response.status,
    headers: body
      ? { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }
      : undefined,
  });
}

export const GET = (request: NextRequest) => forward(request, 'GET');
export const POST = (request: NextRequest) => forward(request, 'POST');
export const PATCH = (request: NextRequest) => forward(request, 'PATCH');
export const PUT = (request: NextRequest) => forward(request, 'PUT');
export const DELETE = (request: NextRequest) => forward(request, 'DELETE');
