'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { fetchSummary, PAYMENT_LABEL, type SalesSummary } from '@/features/sales/types';
import { money } from '@/lib/utils';

export type Shift = { id: string; openedAt: string; closedAt: string | null };

/** Fin del turno: el cierre si lo hubo; si sigue abierto, ahora. */
export const shiftEnd = (shift: Shift) => (shift.closedAt ? new Date(shift.closedAt) : new Date());

/**
 * Lo cobrado en un turno de caja, por método. Mientras el turno está abierto se refresca
 * solo: es lo que la cajera mira antes de cerrar.
 */
export function useShiftSummary(shift: Shift | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['sales-summary', 'shift', shift?.id, shift?.closedAt ?? 'abierta'],
    enabled: !!shift && enabled,
    refetchInterval: shift && !shift.closedAt ? 30_000 : false,
    queryFn: () => fetchSummary(new Date(shift!.openedAt), shiftEnd(shift!)),
  });
}

export const methodTotal = (summary: SalesSummary | undefined, method: string) =>
  summary?.byMethod.find((row) => row.method === method);

const METHODS = ['CASH', 'CARD', 'TRANSFER', 'OTHER'] as const;

export function ShiftSummary({ shift }: { shift: Shift }) {
  const summary = useShiftSummary(shift);
  const data = summary.data;
  const shown = METHODS.filter((method) => method !== 'OTHER' || methodTotal(data, method));
  const params = new URLSearchParams({
    from: shift.openedAt,
    to: shift.closedAt ?? new Date().toISOString(),
  });

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
        <div>
          <h2 className="font-display text-xl font-semibold">Resumen del turno</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {data
              ? `${data.count} ventas por ${money(data.total)}${data.voidCount ? ` · ${data.voidCount} anuladas` : ''}`
              : summary.error
                ? 'No se pudo calcular el resumen.'
                : 'Calculando…'}
          </p>
        </div>
        <Link
          href={`/ventas/historial?${params}`}
          className="text-sm font-semibold text-primary hover:underline"
        >
          Ver ventas del turno →
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead className="bg-secondary/60 text-muted-foreground">
            <tr>
              <th className="p-3 text-left font-medium">Método</th>
              <th className="p-3 text-right font-medium">Cobrado</th>
              <th className="p-3 text-right font-medium">Devuelto</th>
              <th className="p-3 text-right font-medium">Neto</th>
              <th className="p-3 text-left font-medium">Se compara con</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((method) => {
              const row = methodTotal(data, method);
              return (
                <tr key={method}>
                  <td className="p-3 font-medium">{PAYMENT_LABEL[method]}</td>
                  <td className="p-3 text-right tabular-nums">{money(row?.received ?? 0)}</td>
                  <td className="p-3 text-right tabular-nums">{money(row?.refunded ?? 0)}</td>
                  <td className="p-3 text-right font-semibold tabular-nums">
                    {money(row?.net ?? 0)}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {method === 'CASH'
                      ? 'El efectivo contado al cerrar'
                      : method === 'CARD'
                        ? 'El cierre del datáfono'
                        : method === 'TRANSFER'
                          ? 'Los depósitos del banco'
                          : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
