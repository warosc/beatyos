import { sessionFetch } from '@/lib/session-fetch';

export type ServiceTicketStatus = 'PENDING' | 'CHARGED' | 'CANCELLED';

export interface ServiceTicket {
  id: string;
  status: ServiceTicketStatus;
  stylistId: string;
  stylistName: string;
  clientId: string | null;
  clientName: string;
  appointmentId: string | null;
  invoiceId: string | null;
  notes: string | null;
  lines: {
    serviceId: string;
    name: string;
    unitPrice: string;
    taxRate: number | null;
    lineTotal: string;
    available: boolean;
  }[];
  total: string;
  currency: string;
  createdAt: string;
  chargedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export interface AssignableService {
  id: string;
  name: string;
  durationMinutes: number;
  price: string;
  priceWithTax: string;
  currency: string;
}

export const STATUS_LABEL: Record<ServiceTicketStatus, string> = {
  PENDING: 'Pendiente de cobro',
  CHARGED: 'Cobrado',
  CANCELLED: 'Anulado',
};

export { money } from '@/lib/utils';

export const PENDING_COUNT_KEY = ['service-tickets-pending-count'] as const;

/** Cuántos servicios esperan cobro. Lo consultan el menú (aviso en Caja) y Ventas. */
export async function fetchPendingCount(): Promise<number> {
  const r = await sessionFetch('/api/service-tickets?status=PENDING&limit=1');
  if (!r.ok) return 0;
  const b = (await r.json()) as { meta?: { total: number } };
  return b.meta?.total ?? 0;
}

export async function problem(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: string;
    message?: string;
    errors?: { message: string }[];
  };
  return body.errors?.map((e) => e.message).join('. ') || body.detail || body.message || fallback;
}
