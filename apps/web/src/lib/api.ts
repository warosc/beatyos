const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: init?.method && init.method !== 'GET' ? 'no-store' : 'default',
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      detail?: string;
      title?: string;
    } | null;
    throw new ApiError(
      response.status,
      problem?.detail ?? problem?.title ?? 'No pudimos completar la solicitud.',
    );
  }
  const body = (await response.json()) as T | { data: T; meta?: never };
  if (typeof body === 'object' && body !== null && 'data' in body && !('meta' in body))
    return body.data;
  return body as T;
}
