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

export const money = (amount: string | number) =>
  new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ' }).format(Number(amount));

export async function problem(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as {
    detail?: string;
    message?: string;
    errors?: { message: string }[];
  };
  return body.errors?.map((e) => e.message).join('. ') || body.detail || body.message || fallback;
}
