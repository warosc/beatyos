'use client';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchTenantProfile, PAYMENT_LABEL, TENANT_PROFILE_KEY } from '@/features/sales/types';
import { useDialog } from '@/lib/use-dialog';
import { money } from '@/lib/utils';
import { methodTotal, useShiftSummary, type Shift } from './shift-summary';

export type ReportSession = Shift & {
  openingFloat: string;
  cashSales: string;
  expectedAmount: string;
  countedAmount: string | null;
  difference: string | null;
  movements: { id: string; type: string; amount: string; concept: string; occurredAt: string }[];
};

export const MOVEMENT_LABEL: Record<string, string> = {
  CASH_IN: 'Entrada',
  CASH_OUT: 'Salida',
  EXPENSE: 'Gasto',
  WITHDRAWAL: 'Retiro',
  CORRECTION: 'Corrección',
  REFUND: 'Devolución',
};

const at = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('es-GT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * Corte de caja imprimible: lo que se guarda en papel con el efectivo del turno. Mismo
 * formato de 80 mm que el comprobante de venta.
 */
export function CashReport({ session, onClose }: { session: ReportSession; onClose: () => void }) {
  const dialogRef = useDialog(onClose);
  const summary = useShiftSummary(session);
  const profile = useQuery({
    queryKey: TENANT_PROFILE_KEY,
    staleTime: 10 * 60_000,
    queryFn: fetchTenantProfile,
  });
  const difference = session.difference === null ? null : Number(session.difference);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Cierre de caja"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-card">
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted p-4">
          <div className="print-area mx-auto w-full max-w-[80mm] rounded-lg bg-white p-4 font-mono text-[12px] leading-snug text-black shadow-sm">
            <header className="text-center">
              <p className="text-sm font-bold">
                {profile.data?.legalName || profile.data?.name || 'BeautyOS'}
              </p>
              {profile.data?.taxId && <p>NIT: {profile.data.taxId}</p>}
            </header>
            <p className="my-2 border-y border-dashed border-black py-1 text-center font-bold">
              {session.closedAt ? 'CIERRE DE CAJA' : 'CORTE PARCIAL DE CAJA'}
            </p>
            <dl className="space-y-0.5">
              <Pair label="Apertura" value={at(session.openedAt)} />
              <Pair label="Cierre" value={session.closedAt ? at(session.closedAt) : 'Abierta'} />
            </dl>

            <Section title="Efectivo">
              <Pair label="Fondo inicial" value={money(session.openingFloat)} />
              <Pair label="Ventas en efectivo" value={money(session.cashSales)} />
              {session.movements.map((movement) => (
                <Pair
                  key={movement.id}
                  label={
                    movement.type === 'REFUND'
                      ? movement.concept
                      : `${MOVEMENT_LABEL[movement.type] ?? movement.type}: ${movement.concept}`
                  }
                  value={
                    movement.type === 'CORRECTION'
                      ? money(movement.amount)
                      : `${movement.type === 'CASH_IN' ? '+' : '−'}${money(movement.amount)}`
                  }
                />
              ))}
              <Pair label="Esperado" value={money(session.expectedAmount)} strong />
              {session.countedAmount !== null && (
                <>
                  <Pair label="Contado" value={money(session.countedAmount)} strong />
                  <Pair
                    label={
                      difference === 0 ? 'Diferencia' : difference! > 0 ? 'Sobrante' : 'Faltante'
                    }
                    value={money(Math.abs(difference ?? 0))}
                    strong
                  />
                </>
              )}
            </Section>

            <Section title="Ventas del turno">
              {summary.data ? (
                <>
                  <Pair label="Ventas" value={String(summary.data.count)} />
                  <Pair label="Total vendido" value={money(summary.data.total)} />
                  {Number(summary.data.discountTotal) > 0 && (
                    <Pair label="Descuentos" value={money(summary.data.discountTotal)} />
                  )}
                  {summary.data.voidCount > 0 && (
                    <Pair label="Anuladas" value={String(summary.data.voidCount)} />
                  )}
                  {['CASH', 'CARD', 'TRANSFER', 'OTHER'].map((method) => {
                    const row = methodTotal(summary.data, method);
                    if (!row) return null;
                    return (
                      <Pair
                        key={method}
                        label={`${PAYMENT_LABEL[method]}${Number(row.refunded) > 0 ? ` (dev. ${money(row.refunded)})` : ''}`}
                        value={money(row.net)}
                      />
                    );
                  })}
                </>
              ) : (
                <p>Calculando…</p>
              )}
            </Section>

            <div className="mt-6 space-y-6 text-center">
              <p className="border-t border-black pt-1">Firma de quien entrega</p>
              <p className="border-t border-black pt-1">Firma de quien recibe</p>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button onClick={() => window.print()}>
            <Printer size={16} />
            Imprimir
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 border-t border-dashed border-black pt-1">
      <p className="font-bold">{title}</p>
      <dl className="space-y-0.5">{children}</dl>
    </div>
  );
}

function Pair({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'font-bold' : ''}`}>
      <dt>{label}</dt>
      <dd className="text-right whitespace-nowrap">{value}</dd>
    </div>
  );
}
