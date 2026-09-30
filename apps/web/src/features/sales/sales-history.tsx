'use client';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useAccess } from '@/components/session-access';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { usePagedList } from '@/lib/use-paged-list';
import { cn, money } from '@/lib/utils';
import { SaleDialog } from './sale-dialog';
import { SalesTabs } from './sales-tabs';
import { dayRange, fetchSummary, PAYMENT_LABEL, today, type Sale } from './types';

const METHOD_FILTERS = ['CASH', 'CARD', 'TRANSFER', 'OTHER'] as const;
const SUMMARY_METHODS = ['CASH', 'CARD', 'TRANSFER'] as const;

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' }) : '—';
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-GT', { day: '2-digit', month: '2-digit' }) : '';

/**
 * Ventas realizadas: lo que hace falta para cuadrar el día o el turno.
 *
 * Arriba, lo cobrado por método —lo que se compara con el cajón, el datáfono y el banco—;
 * abajo, cada venta, que se abre para ver su comprobante, reimprimirlo o anularla.
 * `?from=&to=` (instantes ISO) llega desde Caja para ver las ventas de un turno concreto.
 */
export function SalesHistory() {
  const { can } = useAccess();
  const params = useSearchParams();
  const shiftFrom = params.get('from');
  const shiftTo = params.get('to');
  const [fromDay, setFromDay] = useState(today());
  const [toDay, setToDay] = useState(today());
  const [text, setText] = useState('');
  const search = useDebouncedValue(text.trim(), 300);
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const range =
    shiftFrom && shiftTo
      ? { from: new Date(shiftFrom), to: new Date(shiftTo) }
      : { from: dayRange(fromDay).from, to: dayRange(toDay).to };
  const valid = !Number.isNaN(range.from.getTime()) && range.from <= range.to;
  const allowed = can('invoices.read');

  const query = new URLSearchParams({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    limit: '25',
    page: String(page),
  });
  if (search) query.set('search', search);
  if (method) query.set('method', method);
  if (status) query.set('status', status);

  const sales = usePagedList<Sale>('sales-history', `/api/sales?${query}`, valid && allowed);
  const summary = useQuery({
    queryKey: ['sales-summary', range.from.toISOString(), range.to.toISOString()],
    enabled: valid && allowed,
    queryFn: () => fetchSummary(range.from, range.to),
  });

  if (!allowed) {
    return (
      <p role="alert" className="p-8 text-center text-sm text-muted-foreground">
        Sin acceso a las ventas realizadas.
      </p>
    );
  }

  const byMethod = (key: string) =>
    summary.data?.byMethod.find((row) => row.method === key) ?? null;
  const refunded = summary.data?.byMethod.reduce((sum, row) => sum + Number(row.refunded), 0) ?? 0;
  const reset = () => setPage(1);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">Cuadre</p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Ventas realizadas</h1>
        </div>
        <SalesTabs />
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        {shiftFrom && shiftTo ? (
          <p className="text-sm">
            Turno de caja: <strong>{new Date(shiftFrom).toLocaleString('es-GT')}</strong> a{' '}
            <strong>{new Date(shiftTo).toLocaleString('es-GT')}</strong>
          </p>
        ) : (
          <>
            <label className="text-sm font-medium">
              Desde
              <input
                type="date"
                value={fromDay}
                max={toDay}
                onChange={(event) => {
                  setFromDay(event.target.value);
                  reset();
                }}
                className="mt-1 block h-10 rounded-lg border bg-background px-2"
              />
            </label>
            <label className="text-sm font-medium">
              Hasta
              <input
                type="date"
                value={toDay}
                min={fromDay}
                onChange={(event) => {
                  setToDay(event.target.value);
                  reset();
                }}
                className="mt-1 block h-10 rounded-lg border bg-background px-2"
              />
            </label>
          </>
        )}
        <label className="flex h-10 min-w-[12rem] flex-1 items-center gap-2 rounded-lg border bg-background px-3">
          <Search size={16} className="text-muted-foreground" />
          <input
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              reset();
            }}
            aria-label="Buscar por número de venta"
            placeholder="Número de venta (F-2026-…)"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <select
          aria-label="Método de pago"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
            reset();
          }}
          className="h-10 rounded-lg border bg-background px-2 text-sm"
        >
          <option value="">Todos los métodos</option>
          {METHOD_FILTERS.map((key) => (
            <option key={key} value={key}>
              {PAYMENT_LABEL[key]}
            </option>
          ))}
        </select>
        <select
          aria-label="Estado"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            reset();
          }}
          className="h-10 rounded-lg border bg-background px-2 text-sm"
        >
          <option value="">Todas</option>
          <option value="PAID">Vigentes</option>
          <option value="VOID">Anuladas</option>
        </select>
      </Card>

      {!valid ? (
        <p role="alert" className="text-sm text-danger">
          La fecha de inicio es posterior a la de fin.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Totales del periodo">
          <Total
            label={`${summary.data?.count ?? 0} ventas`}
            value={summary.data?.total}
            strong
            hint={summary.data?.voidCount ? `${summary.data.voidCount} anuladas aparte` : undefined}
          />
          {SUMMARY_METHODS.map((key) => {
            const row = byMethod(key);
            return (
              <Total
                key={key}
                label={PAYMENT_LABEL[key]}
                value={row?.net ?? '0.00'}
                hint={
                  row && Number(row.refunded) > 0
                    ? `${money(row.received)} cobrado · ${money(row.refunded)} devuelto`
                    : undefined
                }
              />
            );
          })}
          <Total
            label="Descuentos"
            value={summary.data?.discountTotal}
            hint={refunded > 0 ? `Devoluciones: ${money(refunded)}` : undefined}
          />
        </div>
      )}

      <Card className="overflow-hidden">
        {sales.error ? (
          <p role="alert" className="p-6 text-sm text-danger">
            No se pudieron cargar las ventas.{' '}
            <button className="underline" onClick={() => sales.refetch()}>
              Reintentar
            </button>
          </p>
        ) : sales.isPending && valid ? (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Cargando ventas…
          </p>
        ) : sales.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="p-3 font-medium">Hora</th>
                  <th className="p-3 font-medium">Venta</th>
                  <th className="p-3 font-medium">Clienta</th>
                  <th className="p-3 font-medium">Cobró</th>
                  <th className="p-3 font-medium">Pago</th>
                  <th className="p-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sales.data.map((sale) => {
                  const voided = sale.status === 'VOID';
                  return (
                    <tr
                      key={sale.id}
                      tabIndex={0}
                      onClick={() => setOpen(sale.id)}
                      onKeyDown={(event) => event.key === 'Enter' && setOpen(sale.id)}
                      className={cn(
                        'cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                        voided && 'text-muted-foreground',
                      )}
                    >
                      <td className="p-3 whitespace-nowrap">
                        {time(sale.issuedAt)}{' '}
                        <span className="text-xs text-muted-foreground">
                          {shortDate(sale.issuedAt)}
                        </span>
                      </td>
                      <td className="p-3 font-medium whitespace-nowrap">
                        {sale.number}
                        {voided && (
                          <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
                            Anulada
                          </span>
                        )}
                      </td>
                      <td className="p-3">{sale.clientName ?? 'Cliente ocasional'}</td>
                      <td className="p-3">{sale.createdByName ?? '—'}</td>
                      <td className="p-3">
                        {[
                          ...new Set(
                            sale.payments?.map((p) => PAYMENT_LABEL[p.method] ?? p.method),
                          ),
                        ].join(' + ') || '—'}
                      </td>
                      <td
                        className={cn(
                          'p-3 text-right font-semibold tabular-nums',
                          voided && 'line-through',
                        )}
                      >
                        {money(sale.total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-10 text-center text-sm text-muted-foreground">
            No hay ventas en este periodo.
          </p>
        )}
      </Card>
      <Pagination meta={sales.meta} pending={sales.isFetching} onPage={setPage} />

      {open && <SaleDialog saleId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Total({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value?: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <Card className={cn('p-4', strong && 'border-primary/40 bg-primary/5')}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value ? money(value) : '—'}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
