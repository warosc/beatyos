'use client';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DialogClose } from '@/components/ui/dialog-close';
import { sessionFetch } from '@/lib/session-fetch';
import { useDialog } from '@/lib/use-dialog';

/** Lo que impide dar de baja a una profesional, como lo devuelve la API (ADR-0028). */
export type StylistRetirement = {
  stylistId: string;
  displayName: string;
  blocked: boolean;
  appointmentsTotal: number;
  appointments: {
    id: string;
    startsAt: string;
    status: string;
    clientName: string;
    serviceNames: string[];
  }[];
  pendingTicketsTotal: number;
  pendingTickets: { id: string; createdAt: string; clientName: string }[];
  activeQueueTurns: { id: string; number: number; clientName: string; status: string }[];
  waitingPreferences: number;
  hasAccount: boolean;
  accountWillBeDeactivated: boolean;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('es-GT', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

async function loadRetirement(id: string): Promise<StylistRetirement> {
  const response = await sessionFetch(`/api/stylists/${encodeURIComponent(id)}/retirement`);
  const body = (await response.json().catch(() => ({}))) as {
    data?: StylistRetirement;
    detail?: string;
    message?: string;
  };
  if (!response.ok || !body.data) {
    throw new Error(body.detail ?? body.message ?? 'No pudimos revisar sus pendientes.');
  }
  return body.data;
}

/**
 * Dar de baja a una profesional.
 *
 * Primero pregunta a la API qué tiene pendiente: con citas por atender, comandas sin cobrar
 * o turnos en curso no se puede, y se listan para que la dueña los resuelva. Sin nada
 * pendiente, explica qué va a pasar antes de confirmar.
 */
export function StylistRetirementDialog({
  stylist,
  onClose,
  onRetired,
}: {
  stylist: { id: string; displayName: string };
  onClose: () => void;
  onRetired: (name: string) => Promise<unknown>;
}) {
  const dialogRef = useDialog(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = useQuery({
    queryKey: ['stylist-retirement', stylist.id],
    queryFn: () => loadRetirement(stylist.id),
    staleTime: 0,
  });
  const data = check.data;

  async function retire() {
    setBusy(true);
    setError('');
    const response = await sessionFetch(`/api/stylists/${encodeURIComponent(stylist.id)}`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (response.ok) {
      await onRetired(stylist.displayName);
      onClose();
      return;
    }
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
      message?: string;
    };
    // Algo cambió entre la revisión y la baja (le agendaron una cita): se vuelve a revisar
    // para mostrar la lista al día.
    if (body.code === 'STYLIST_HAS_PENDING_WORK') await check.refetch();
    setError(body.detail ?? body.message ?? 'No pudimos darla de baja.');
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Dar de baja a ${stylist.displayName}`}
        className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-2xl font-semibold">
            {data?.blocked
              ? `Antes de dar de baja a ${stylist.displayName}`
              : `Dar de baja a ${stylist.displayName}`}
          </h2>
          <DialogClose onClose={onClose} />
        </div>

        {check.isPending && <p role="status">Revisando sus pendientes…</p>}
        {check.isError && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {check.error.message}
          </p>
        )}

        {data?.blocked && (
          <div className="space-y-4 text-sm">
            <p>Tiene trabajo pendiente. Resuélvelo y vuelve a revisar para darla de baja.</p>
            {data.appointmentsTotal > 0 && (
              <section aria-label="Citas pendientes">
                <h3 className="font-semibold">
                  {plural(data.appointmentsTotal, 'cita pendiente', 'citas pendientes')}
                </h3>
                <ul className="mt-2 space-y-1">
                  {data.appointments.map((item) => (
                    <li key={item.id} className="rounded-lg bg-muted p-2">
                      {when(item.startsAt)} · {item.clientName}
                      {item.serviceNames.length > 0 && ` · ${item.serviceNames.join(' + ')}`}
                    </li>
                  ))}
                </ul>
                {data.appointmentsTotal > data.appointments.length && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Y {data.appointmentsTotal - data.appointments.length} más.
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  Reasígnalas a otra profesional o cancélalas en la agenda.
                </p>
              </section>
            )}
            {data.pendingTicketsTotal > 0 && (
              <section aria-label="Comandas sin cobrar">
                <h3 className="font-semibold">
                  {plural(data.pendingTicketsTotal, 'comanda sin cobrar', 'comandas sin cobrar')}
                </h3>
                <ul className="mt-2 space-y-1">
                  {data.pendingTickets.map((item) => (
                    <li key={item.id} className="rounded-lg bg-muted p-2">
                      {when(item.createdAt)} · {item.clientName}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-muted-foreground">Cóbralas o anúlalas en caja.</p>
              </section>
            )}
            {data.activeQueueTurns.length > 0 && (
              <section aria-label="Turnos en curso">
                <h3 className="font-semibold">
                  {plural(data.activeQueueTurns.length, 'turno en curso', 'turnos en curso')}
                </h3>
                <ul className="mt-2 space-y-1">
                  {data.activeQueueTurns.map((turn) => (
                    <li key={turn.id} className="rounded-lg bg-muted p-2">
                      Turno {turn.number} · {turn.clientName}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-muted-foreground">
                  Termínalos o devuélvelos a la fila en Turnos.
                </p>
              </section>
            )}
          </div>
        )}

        {data && !data.blocked && (
          <div className="space-y-2 text-sm">
            <p>
              Dejará de aparecer en la agenda, el punto de venta, los turnos y las metas.
              {data.accountWillBeDeactivated && ' Su acceso al sistema se desactivará.'}
            </p>
            <p>
              Sus ventas, citas y comisiones pasadas se conservan con su nombre. Podrás reactivarla
              desde «Dadas de baja».
            </p>
            {data.waitingPreferences > 0 && (
              <p className="rounded-xl bg-secondary p-3">
                {data.waitingPreferences === 1
                  ? '1 clienta en espera la pidió: pasará a la fila general.'
                  : `${data.waitingPreferences} clientas en espera la pidieron: pasarán a la fila general.`}
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {data?.blocked ? 'Cerrar' : 'Cancelar'}
          </Button>
          {data?.blocked ? (
            <Button type="button" onClick={() => check.refetch()} disabled={check.isFetching}>
              <RefreshCw size={16} />
              {check.isFetching ? 'Revisando…' : 'Volver a revisar'}
            </Button>
          ) : (
            <Button type="button" onClick={retire} disabled={!data || busy}>
              <UserMinus size={16} />
              {busy ? 'Dando de baja…' : 'Dar de baja'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
