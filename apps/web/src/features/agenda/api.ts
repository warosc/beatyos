'use client';
import { problem } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';

/**
 * Llamadas de la agenda a sus rutas de servidor.
 *
 * Toda escritura devuelve `{ ok, error }` en lugar de lanzar: la pantalla siempre quiere
 * enseñar el motivo —«Sara ya tiene una cita a esa hora»— y nunca un error genérico.
 */

export async function agendaGet<T>(resource: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({ resource, ...params });
  const response = await sessionFetch(`/api/agenda?${query}`);
  if (!response.ok) throw new Error(await problem(response, 'No pudimos cargar la agenda.'));
  return ((await response.json()) as { data: T }).data;
}

export type Outcome<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function agendaSend<T = unknown>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  fallback = 'No pudimos guardar el cambio.',
): Promise<Outcome<T>> {
  const response = await sessionFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: await problem(response, fallback) };
  if (response.status === 204) return { ok: true, data: undefined as T };
  const json = (await response.json().catch(() => ({}))) as { data?: T };
  return { ok: true, data: json.data as T };
}

/** Acción sobre una cita: `/api/agenda/:id?action=…`. */
export const appointmentAction = <T = unknown>(
  id: string,
  action:
    | 'reschedule'
    | 'confirm'
    | 'start'
    | 'complete'
    | 'cancel'
    | 'no-show'
    | 'notes'
    | 'change-request'
    | 'reminder',
  body: unknown = {},
) =>
  agendaSend<T>(
    `/api/agenda/${encodeURIComponent(id)}?action=${action}`,
    action === 'change-request' || action === 'reminder' ? 'POST' : 'PATCH',
    body,
  );
