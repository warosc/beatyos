'use client';
import { useAccess } from '@/components/session-access';
import { usePagedList } from '@/lib/use-paged-list';
import { loadOptions } from '@/lib/pagination';
import { Pagination } from '@/components/ui/pagination';
import { Card } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { Scissors } from 'lucide-react';
import { useState } from 'react';

type InvoiceLine = {
  kind: 'PRODUCT' | 'SERVICE';
  description: string;
  stylistId: string | null;
  lineTotal: string;
};
type Invoice = {
  id: string;
  number: string;
  issuedAt: string;
  currency: string;
  lines: InvoiceLine[];
};
type Stylist = { id: string; displayName: string };

export function ServiceHistory({ clientId }: { clientId: string }) {
  const { can } = useAccess();
  const [page, setPage] = useState(1);
  const invoices = usePagedList<Invoice>(
    'client-invoices',
    `/api/sales?clientId=${encodeURIComponent(clientId)}&limit=10&page=${page}`,
  );
  const stylists = useQuery({
    queryKey: ['stylists'],
    enabled: can('stylists.read'),
    queryFn: ({ signal }) => loadOptions<Stylist>('/api/agenda?resource=stylists', signal),
  });
  const stylistName = (id: string | null) =>
    id ? (stylists.data?.find((s) => s.id === id)?.displayName ?? null) : null;

  // Solo interesan las visitas que dejaron algún servicio: una factura de solo producto no es
  // un servicio prestado y no pertenece a esta bitácora.
  const visits = (invoices.data ?? [])
    .map((invoice) => ({ invoice, services: invoice.lines.filter((l) => l.kind === 'SERVICE') }))
    .filter((visit) => visit.services.length > 0);

  return (
    <div>
      {invoices.isPending && <p role="status">Cargando historial…</p>}
      {invoices.error && (
        <p role="alert">
          No se pudo cargar el historial.{' '}
          <button onClick={() => invoices.refetch()}>Reintentar</button>
        </p>
      )}
      {!invoices.isPending && !invoices.error && visits.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Todavía no hay servicios registrados para esta clienta.
        </p>
      )}
      <div className="space-y-3">
        {visits.map(({ invoice, services }) => (
          <Card key={invoice.id} className="p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {new Intl.DateTimeFormat('es-GT', { dateStyle: 'long' }).format(
                  new Date(invoice.issuedAt),
                )}
              </span>
              <span>{invoice.number}</span>
            </div>
            <ul className="mt-3 space-y-2">
              {services.map((line, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <Scissors size={15} className="shrink-0 text-muted-foreground" />
                    {line.description}
                    {stylistName(line.stylistId) && (
                      <small className="text-muted-foreground">
                        · {stylistName(line.stylistId)}
                      </small>
                    )}
                  </span>
                  <strong className="whitespace-nowrap">
                    {line.lineTotal} {invoice.currency}
                  </strong>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <Pagination meta={invoices.meta} pending={invoices.isFetching} onPage={setPage} />
    </div>
  );
}
