export type ExecutiveReport = {
  period: { from: string; to: string };
  currency: 'GTQ';
  sales: string;
  tickets: number;
  averageTicket: string;
  retentionRate: number;
  occupancyRate: number;
  completedAppointments: number;
  cancelledAppointments: number;
  commissionTotal: string;
  topProducts: { name: string; quantity: number; revenue: string }[];
  topStylists: { name: string; services: number; revenue: string; commission: string }[];
  dailySales: { date: string; total: string }[];
};
export type DashboardReport = ExecutiveReport & {
  lowStockCount: number;
  upcoming: {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    client: string;
    stylist: string;
    stylistColor: string;
    service: string;
  }[];
  cash: { isOpen: boolean; openedAt: string | null; expected: string };
};
export async function loadReport<T>(resource: 'executive' | 'dashboard', params = '') {
  const response = await fetch(`/api/reports?resource=${resource}${params}`, { cache: 'no-store' });
  const body = (await response.json()) as { data?: T; detail?: string; message?: string };
  if (!response.ok)
    throw new Error(body.detail ?? body.message ?? 'No pudimos cargar los indicadores.');
  return body.data as T;
}
