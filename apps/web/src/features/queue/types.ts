import { problem, type ServiceTicket } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';

export type QueueTurnStatus =
  'WAITING' | 'CALLED' | 'IN_SERVICE' | 'DONE' | 'NO_SHOW' | 'CANCELLED';

export interface QueueTurn {
  id: string;
  number: number;
  businessDate: string;
  status: QueueTurnStatus;
  clientId: string | null;
  clientName: string;
  serviceIds: string[];
  serviceNames: string[];
  preferredStylistId: string | null;
  preferredStylistName: string | null;
  stylistId: string | null;
  stylistName: string | null;
  /** Puesto en la fila: 1 = la siguiente. Solo en espera. */
  position: number | null;
  notes: string | null;
  callCount: number;
  createdAt: string;
  calledAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  serviceTicketId: string | null;
  cancellationReason: string | null;
}

export interface QueueBoard {
  businessDate: string;
  turns: QueueTurn[];
}

/** Lo que enseña la pantalla de la sala. Nada más que esto sale de la API pública. */
export interface QueueDisplay {
  salonName: string;
  called: {
    id: string;
    number: number;
    publicName: string;
    stylistName: string;
    callCount: number;
    calledAt: string;
  }[];
  waiting: number[];
  waitingCount: number;
}

export const QUEUE_STATUS_LABEL: Record<QueueTurnStatus, string> = {
  WAITING: 'En espera',
  CALLED: 'Llamada',
  IN_SERVICE: 'En el sillón',
  DONE: 'Atendida',
  NO_SHOW: 'No vino',
  CANCELLED: 'Se fue',
};

/** Todo lo de la fila cuelga de esta clave: el canal en vivo la invalida entera. */
export const QUEUE_KEY = ['queue'] as const;

export const isActive = (turn: QueueTurn) =>
  turn.status === 'CALLED' || turn.status === 'IN_SERVICE';

export async function fetchQueue(): Promise<QueueBoard> {
  const response = await sessionFetch('/api/queue');
  if (!response.ok) throw new Error(await problem(response, 'No pudimos cargar la fila.'));
  return ((await response.json()) as { data: QueueBoard }).data;
}

export type QueueOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Escrituras de la fila. Devuelven el motivo en vez de lanzar: la pantalla lo enseña. */
export async function queueSend<T>(
  url: string,
  body: unknown = {},
  fallback = 'No pudimos guardar el cambio.',
): Promise<QueueOutcome<T>> {
  const response = await sessionFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: await problem(response, fallback) };
  return { ok: true, data: ((await response.json()) as { data: T }).data };
}

export type QueueAction = 'recall' | 'start' | 'no-show' | 'requeue' | 'cancel';

export const queueAction = (id: string, action: QueueAction, body: unknown = {}) =>
  queueSend<QueueTurn>(`/api/queue/${encodeURIComponent(id)}/${action}`, body);

export const callTurn = (id: string, stylistId: string) =>
  queueSend<QueueTurn>(`/api/queue/${encodeURIComponent(id)}/call`, { stylistId });

export const callNext = (stylistId?: string) =>
  queueSend<{ turn: QueueTurn | null }>('/api/queue/next', stylistId ? { stylistId } : {});

export const finishTurn = (id: string, serviceIds: string[], notes?: string) =>
  queueSend<{ turn: QueueTurn; ticket: ServiceTicket }>(
    `/api/queue/${encodeURIComponent(id)}/finish`,
    { serviceIds, ...(notes ? { notes } : {}) },
    'No pudimos registrar el servicio.',
  );

/** «Hace 12 min»: cuánto lleva esperando, para que recepción vea a quién atender antes. */
export function waitedLabel(since: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  if (minutes < 1) return 'recién llegada';
  if (minutes < 60) return `espera ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `espera ${hours} h ${minutes % 60} min`;
}

/**
 * Clave de una llamada en la pantalla: cambia cada vez que se llama a la clienta, también al
 * volver a llamarla. Es lo que decide si suena la campanita.
 */
export const callKey = (call: QueueDisplay['called'][number]) => `${call.id}:${call.callCount}`;

/** Lo que dice la voz de la pantalla. Los números se leen mejor en cifras que deletreados. */
export const announcement = (call: QueueDisplay['called'][number]) =>
  `Turno ${call.number}. ${call.publicName}, pase con ${call.stylistName}.`;
