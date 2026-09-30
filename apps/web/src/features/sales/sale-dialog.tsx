'use client';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Printer } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { CASH_KEY, fetchCurrentCash } from '@/features/cash/cash-api';
import { problem } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';
import { useDialog } from '@/lib/use-dialog';
import { money } from '@/lib/utils';
import { Receipt } from './receipt';
import {
  fetchSale,
  fetchTenantProfile,
  PAYMENT_LABEL,
  pendingRefund,
  TENANT_PROFILE_KEY,
  type Sale,
} from './types';

/**
 * Una venta: su comprobante, reimprimible, y —solo para la propietaria— su anulación.
 *
 * `initial` sirve para imprimir en el momento del cobro sin esperar al detalle, y es lo único
 * que tiene quien cobra sin permiso para consultar ventas (una estilista en el mostrador).
 */
export function SaleDialog({
  saleId,
  initial,
  cash,
  onClose,
  closeLabel = 'Cerrar',
}: {
  saleId: string;
  initial?: Sale;
  cash?: { tenderedCents: number; changeCents: number } | null;
  onClose: () => void;
  closeLabel?: string;
}) {
  const { can } = useAccess();
  const dialogRef = useDialog(onClose);
  const [voiding, setVoiding] = useState(false);
  const [notice, setNotice] = useState('');
  const detail = useQuery({
    queryKey: ['sale', saleId],
    enabled: can('invoices.read'),
    queryFn: () => fetchSale(saleId),
  });
  const profile = useQuery({
    queryKey: TENANT_PROFILE_KEY,
    staleTime: 10 * 60_000,
    queryFn: fetchTenantProfile,
  });
  const sale = detail.data ?? initial;
  const canVoid = can('invoices.void') && sale && sale.status !== 'VOID';

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={sale ? `Venta ${sale.number}` : 'Venta'}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-card">
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted p-4">
          {sale ? (
            <div className="rounded-lg shadow-sm">
              <Receipt sale={sale} profile={profile.data} cash={cash} />
            </div>
          ) : detail.error ? (
            <p role="alert" className="p-6 text-sm text-danger">
              {detail.error.message}
            </p>
          ) : (
            <p role="status" className="p-6 text-sm text-muted-foreground">
              Cargando venta…
            </p>
          )}
        </div>

        {notice && (
          <p role="status" className="border-t bg-success/10 p-3 text-sm text-success">
            {notice}
          </p>
        )}

        {voiding && sale ? (
          <VoidForm
            sale={sale}
            onCancel={() => setVoiding(false)}
            onDone={(message) => {
              setVoiding(false);
              setNotice(message);
            }}
          />
        ) : (
          <div className="flex flex-wrap justify-end gap-2 border-t p-4">
            {canVoid && (
              <Button
                variant="ghost"
                className="mr-auto text-danger"
                onClick={() => setVoiding(true)}
              >
                <Ban size={16} />
                Anular venta
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              {closeLabel}
            </Button>
            <Button disabled={!sale} onClick={() => window.print()}>
              <Printer size={16} />
              Imprimir
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Anulación con reversa (ADR-0020). Antes de confirmar dice exactamente qué va a pasar: de
 * qué caja sale el efectivo, qué hay que devolver por datáfono o banco y qué vuelve al
 * inventario.
 */
function VoidForm({
  sale,
  onCancel,
  onDone,
}: {
  sale: Sale;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cash = useQuery({ queryKey: CASH_KEY, queryFn: fetchCurrentCash });

  const payments = (sale.payments ?? []).filter((payment) => pendingRefund(payment) > 0);
  const cashBack = payments
    .filter((payment) => payment.method === 'CASH')
    .reduce((sum, payment) => sum + pendingRefund(payment), 0);
  const otherBack = payments.filter((payment) => payment.method !== 'CASH');
  const products = sale.lines.filter((line) => line.kind === 'PRODUCT');
  const stylists = [...new Set(sale.lines.map((line) => line.stylistName).filter(Boolean))];
  const blocked = cashBack > 0 && cash.isSuccess && !cash.data;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const response = await sessionFetch(`/api/sales/${encodeURIComponent(sale.id)}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    setBusy(false);
    if (!response.ok) return setError(await problem(response, 'No pudimos anular la venta.'));
    await Promise.all(
      [['sale', sale.id], ['sales-history'], ['sales-summary'], CASH_KEY, ['pos-catalog']].map(
        (queryKey) => qc.invalidateQueries({ queryKey }),
      ),
    );
    const parts = [
      cashBack > 0 ? `entrega ${money(cashBack)} en efectivo` : null,
      ...otherBack.map(
        (payment) =>
          `devuelve ${money(pendingRefund(payment))} por ${PAYMENT_LABEL[payment.method]?.toLowerCase() ?? payment.method}`,
      ),
    ].filter(Boolean);
    onDone(`Venta ${sale.number} anulada.${parts.length ? ` Ahora ${parts.join(' y ')}.` : ''}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t p-4">
      <h2 className="font-display text-lg font-semibold">Anular {sale.number}</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {cashBack > 0 && (
          <li>
            Salen <strong>{money(cashBack)}</strong> en efectivo de la caja abierta.
          </li>
        )}
        {otherBack.map((payment) => (
          <li key={payment.id}>
            Devuelve <strong>{money(pendingRefund(payment))}</strong> por{' '}
            {PAYMENT_LABEL[payment.method]?.toLowerCase() ?? payment.method}
            {payment.reference ? ` (ref. ${payment.reference})` : ''}.
          </li>
        ))}
        {products.length > 0 && (
          <li>
            {products.length === 1 ? 'El producto vuelve' : 'Los productos vuelven'} al inventario.
          </li>
        )}
        {stylists.length > 0 && <li>Deja de contar en las comisiones de {stylists.join(', ')}.</li>}
      </ul>
      {blocked && (
        <p role="alert" className="rounded-xl bg-warning/10 p-3 text-sm text-warning">
          Esta venta se cobró en efectivo y la caja está cerrada.{' '}
          <Link href="/caja" className="font-semibold underline">
            Abre la caja
          </Link>{' '}
          para poder devolverlo.
        </p>
      )}
      <label className="block text-sm font-semibold">
        Motivo
        <textarea
          required
          minLength={3}
          maxLength={250}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Por ejemplo: cobrada a la clienta equivocada"
          className="mt-1 w-full rounded-xl border bg-background p-3 font-normal"
        />
      </label>
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Volver
        </Button>
        <Button
          disabled={busy || blocked || reason.trim().length < 3}
          className="bg-danger text-white hover:bg-danger/90"
        >
          {busy ? 'Anulando…' : 'Anular venta'}
        </Button>
      </div>
    </form>
  );
}
