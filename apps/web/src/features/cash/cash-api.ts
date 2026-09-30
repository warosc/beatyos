import { sessionFetch } from '@/lib/session-fetch';

/** Misma clave que la pantalla de Caja: abrirla o cerrarla se refleja en todas partes. */
export const CASH_KEY = ['cash'] as const;

/** La caja abierta, o `null` si no hay ninguna. */
export async function fetchCurrentCash(): Promise<{ id: string; openedAt: string } | null> {
  const response = await sessionFetch('/api/cash?resource=current');
  const body = (await response.json()) as {
    data?: { id: string; openedAt: string } | null;
    detail?: string;
  };
  if (!response.ok) throw new Error(body.detail);
  return body.data ?? null;
}
