import { problem } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';

export type SalePayment = {
  id: string;
  method: string;
  status: string;
  amount: string;
  refundedAmount: string;
  reference: string | null;
  receivedAt: string;
  refundedAt: string | null;
};

export type SaleLine = {
  id: string;
  kind: 'PRODUCT' | 'SERVICE';
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  lineTotal: string;
  stylistName: string | null;
};

export type Sale = {
  id: string;
  number: string;
  status: string;
  clientName: string | null;
  createdByName: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  currency: string;
  lines: SaleLine[];
  payments?: SalePayment[];
};

export type SalesSummary = {
  count: number;
  total: string;
  discountTotal: string;
  voidCount: number;
  byMethod: { method: string; received: string; refunded: string; net: string }[];
};

export type TenantProfile = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  addressLine: string | null;
  city: string | null;
  phone: string | null;
  email: string;
  brandTheme: string;
  /** Línea libre al pie de los comprobantes. */
  receiptNote: string | null;
};

/** Todos los métodos que puede devolver la API, no solo los que ofrece el punto de venta. */
export const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Otro',
  BIZUM: 'Bizum',
  GIFT_CARD: 'Tarjeta regalo',
  VOUCHER: 'Vale',
};

export const TENANT_PROFILE_KEY = ['tenant-profile'] as const;

async function getData<T>(url: string, fallback: string): Promise<T> {
  const response = await sessionFetch(url);
  if (!response.ok) throw new Error(await problem(response, fallback));
  return ((await response.json()) as { data: T }).data;
}

export const fetchSale = (id: string) =>
  getData<Sale>(`/api/sales/${encodeURIComponent(id)}`, 'No se pudo cargar la venta.');

export const fetchSummary = (from: Date, to: Date) =>
  getData<SalesSummary>(
    `/api/sales/summary?from=${from.toISOString()}&to=${to.toISOString()}`,
    'No se pudo calcular el cuadre.',
  );

export const fetchTenantProfile = () =>
  getData<TenantProfile>('/api/tenant/profile', 'No se pudieron cargar los datos del salón.');

/** Un día completo en la hora del navegador, que es la del salón. */
export function dayRange(day: string): { from: Date; to: Date } {
  const [year, month, date] = day.split('-').map(Number);
  return {
    from: new Date(year, month - 1, date, 0, 0, 0, 0),
    to: new Date(year, month - 1, date, 23, 59, 59, 999),
  };
}

export const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** Lo que falta por devolver de un cobro. */
export const pendingRefund = (payment: SalePayment) =>
  Number(payment.amount) - Number(payment.refundedAmount);
