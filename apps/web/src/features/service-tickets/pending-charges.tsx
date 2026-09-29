'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CircleDollarSign, XCircle } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Can } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { loadPage } from '@/lib/pagination';
import { sessionFetch } from '@/lib/session-fetch';
import { useDialog } from '@/lib/use-dialog';
import { money, problem, type ServiceTicket } from './types';

export const PENDING_TICKETS_URL =
  '/api/service-tickets?status=PENDING&sort=createdAt:asc&limit=100';

const since = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'ahora mismo';
  if (minutes < 60) return `hace ${minutes} min`;
  return new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Bandeja de caja: lo que las profesionales han declarado y falta cobrar.
 *
 * Se refresca sola para que la recepcionista vea llegar cada servicio sin recargar la
 * página. Cobrar emite la factura en el servidor con la misma lógica que el punto de venta.
 */
export function PendingCharges({ cashOpen }: { cashOpen: boolean }) {
  const [charging, setCharging] = useState<ServiceTicket | null>(null);
  const [cancelling, setCancelling] = useState<ServiceTicket | null>(null);
  const [notice, setNotice] = useState('');
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ['service-tickets-pending'],
    refetchInterval: 20_000,
    queryFn: ({ signal }) => loadPage<ServiceTicket>(PENDING_TICKETS_URL, signal),
  });
  const tickets = pending.data?.data ?? [];

  async function done(message: string) {
    setCharging(null);
    setCancelling(null);
    setNotice(message);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['service-tickets-pending'] }),
      qc.invalidateQueries({ queryKey: ['service-tickets-pending-count'] }),
      qc.invalidateQueries({ queryKey: ['cash'] }),
      qc.invalidateQueries({ queryKey: ['cash-history'] }),
    ]);
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
            <BellRing size={20} className="text-primary" />
            Servicios por cobrar
            {tickets.length > 0 && (
              <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-bold text-primary-foreground">
                {tickets.length}
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Registrados por las estilistas al terminar cada servicio.
          </p>
        </div>
      </div>
      {notice && (
        <p role="status" className="border-b bg-success/10 p-3 text-sm text-success">
          {notice}
        </p>
      )}
      {pending.error ? (
        <p role="alert" className="p-5 text-sm">
          No se pudieron cargar los servicios pendientes.{' '}
          <button onClick={() => pending.refetch()}>Reintentar</button>
        </p>
      ) : tickets.length ? (
        <div className="divide-y">
          {tickets.map((t) => {
            const blocked = t.lines.some((l) => !l.available);
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{t.clientName}</p>
                  <p className="text-sm text-muted-foreground">
                    {t.lines.map((l) => l.name).join(', ')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Atendida por <strong>{t.stylistName}</strong> · {since(t.createdAt)}
                    {t.notes ? ` · «${t.notes}»` : ''}
                  </p>
                  {blocked && (
                    <p className="mt-1 text-xs text-danger">
                      Incluye un servicio retirado del catálogo: anúlala y pide que la registren de
                      nuevo.
                    </p>
                  )}
                </div>
                <strong className="text-lg">{money(t.total)}</strong>
                <div className="flex gap-2">
                  <Can permission={['invoices.create', 'payments.create']}>
                    <Button disabled={blocked} onClick={() => setCharging(t)}>
                      <CircleDollarSign size={17} />
                      Cobrar
                    </Button>
                  </Can>
                  <Can permission="service-tickets.cancel">
                    <Button
                      variant="ghost"
                      aria-label={`Anular servicio de ${t.clientName}`}
                      onClick={() => setCancelling(t)}
                    >
                      <XCircle size={17} />
                    </Button>
                  </Can>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        !pending.isPending && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No hay servicios pendientes de cobro.
          </p>
        )
      )}
      {charging && (
        <ChargeDialog
          ticket={charging}
          cashOpen={cashOpen}
          onClose={() => setCharging(null)}
          onDone={done}
        />
      )}
      {cancelling && (
        <CancelDialog ticket={cancelling} onClose={() => setCancelling(null)} onDone={done} />
      )}
    </Card>
  );
}

function ChargeDialog({
  ticket,
  cashOpen,
  onClose,
  onDone,
}: {
  ticket: ServiceTicket;
  cashOpen: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [method, setMethod] = useState(cashOpen ? 'CASH' : 'CARD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialog(onClose);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await sessionFetch(`/api/service-tickets/${ticket.id}/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payments: [{ method, amount: Number(ticket.total) }] }),
    });
    setBusy(false);
    if (!r.ok) return setError(await problem(r, 'No pudimos cobrar el servicio.'));
    const { data } = (await r.json()) as { data: { number: string; total: string } };
    onDone(`Cobrado ${money(data.total)} a ${ticket.clientName} · factura ${data.number}`);
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Cobrar servicio"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6">
        <h2 className="font-display text-2xl font-semibold">Cobrar servicio</h2>
        <p className="text-sm text-muted-foreground">
          {ticket.clientName} · atendida por {ticket.stylistName}
        </p>
        <div className="space-y-2 rounded-xl bg-secondary p-3 text-sm">
          {ticket.lines.map((l) => (
            <div key={l.serviceId} className="flex justify-between gap-3">
              <span>{l.name}</span>
              <span>{money(l.lineTotal)}</span>
            </div>
          ))}
          <div className="flex justify-between border-t pt-2 text-base font-bold">
            <span>Total</span>
            <span>{money(ticket.total)}</span>
          </div>
        </div>
        <label className="block text-sm font-semibold">
          Método de pago
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="mt-1 h-11 w-full rounded-xl border bg-background px-3 font-normal"
          >
            <option value="CASH">Efectivo</option>
            <option value="CARD">Tarjeta</option>
            <option value="TRANSFER">Transferencia</option>
          </select>
        </label>
        {method === 'CASH' && !cashOpen && (
          <p className="rounded-xl bg-warning/10 p-3 text-sm text-warning">
            La caja está cerrada: ábrela antes de cobrar en efectivo.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy || (method === 'CASH' && !cashOpen)}>
            {busy ? 'Cobrando…' : `Cobrar ${money(ticket.total)}`}
          </Button>
        </div>
      </form>
    </div>
  );
}

function CancelDialog({
  ticket,
  onClose,
  onDone,
}: {
  ticket: ServiceTicket;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialog(onClose);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    const r = await sessionFetch(`/api/service-tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    setBusy(false);
    if (!r.ok) return setError(await problem(r, 'No pudimos anular el servicio.'));
    onDone(`Servicio de ${ticket.clientName} anulado.`);
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Anular servicio"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6">
        <h2 className="font-display text-2xl font-semibold">Anular servicio</h2>
        <p className="text-sm text-muted-foreground">
          {ticket.clientName} · {ticket.lines.map((l) => l.name).join(', ')}
        </p>
        <label className="block text-sm font-semibold">
          Motivo
          <input
            required
            minLength={3}
            maxLength={250}
            name="reason"
            className="mt-1 h-11 w-full rounded-xl border bg-background px-3 font-normal"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button disabled={busy}>{busy ? 'Anulando…' : 'Anular'}</Button>
        </div>
      </form>
    </div>
  );
}
