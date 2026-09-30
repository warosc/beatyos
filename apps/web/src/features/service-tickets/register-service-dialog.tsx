'use client';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, Send, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import type { Appointment } from '@/features/agenda/types';
import { ClientCombobox, type PosClient } from '@/features/sales/client-combobox';
import { sessionFetch } from '@/lib/session-fetch';
import { useDialog } from '@/lib/use-dialog';
import { cn } from '@/lib/utils';
import { money, problem, type AssignableService, type ServiceTicket } from './types';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

/**
 * «¿Qué le hiciste?»: la profesional declara los servicios para que caja los cobre.
 *
 * Pensado para el móvil y para hacerse entre clienta y clienta: si viene de una cita, la
 * clienta ya está puesta y lo reservado viene marcado, así que lo normal son dos toques.
 * Solo ofrece los servicios que la profesional tiene asignados; el servidor lo vuelve a
 * comprobar.
 *
 * Con `onBehalfOf`, recepción lo registra a nombre de la profesional de la cita: la comanda
 * —y la comisión— siguen siendo de ella.
 */
export function RegisterServiceDialog({
  appointment,
  onBehalfOf,
  onClose,
  onDone,
}: {
  /** Sin cita es una clienta que llegó sin reservar. */
  appointment?: Appointment | null;
  onBehalfOf?: { stylistId: string; name: string };
  onClose: () => void;
  onDone: (ticket: ServiceTicket) => void;
}) {
  const { can } = useAccess();
  const dialogRef = useDialog(onClose);
  const [client, setClient] = useState<PosClient | null>(null);
  const [walkInName, setWalkInName] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [filter, setFilter] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const services = useQuery({
    queryKey: ['assignable-services', onBehalfOf?.stylistId ?? 'me'],
    queryFn: async () => {
      const query = onBehalfOf ? `?stylistId=${encodeURIComponent(onBehalfOf.stylistId)}` : '';
      const response = await sessionFetch(`/api/service-tickets/assignable${query}`);
      if (!response.ok)
        throw new Error(await problem(response, 'No se pudieron cargar los servicios.'));
      return ((await response.json()) as { data: AssignableService[] }).data;
    },
  });
  const catalog = useMemo(() => services.data ?? [], [services.data]);
  const booked = useMemo(
    () => new Set(appointment?.services.map((line) => line.serviceId) ?? []),
    [appointment],
  );
  // Lo reservado viene marcado hasta que ella toque algo: desde entonces manda su selección.
  const selected = picked ?? new Set(catalog.filter((s) => booked.has(s.id)).map((s) => s.id));
  const shown = catalog.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const total = catalog
    .filter((service) => selected.has(service.id))
    .reduce((sum, service) => sum + Number(service.priceWithTax), 0);

  const clientLabel = appointment
    ? (appointment.clientName ?? 'tu clienta')
    : (client?.fullName ?? walkInName.trim());
  const hasClient = !!appointment || !!client || walkInName.trim().length > 1;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !selected.size || !hasClient) return;
    setBusy(true);
    setError('');
    const response = await sessionFetch('/api/service-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceIds: [...selected],
        appointmentId: appointment?.id,
        clientId: appointment?.clientId ?? client?.id,
        clientName: !appointment && !client ? walkInName.trim() : undefined,
        stylistId: onBehalfOf?.stylistId,
        notes: notes.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!response.ok) return setError(await problem(response, 'No pudimos registrar el servicio.'));
    onDone(((await response.json()) as { data: ServiceTicket }).data);
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Registrar lo realizado"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
    >
      <form
        onSubmit={submit}
        className="flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-card sm:max-w-lg sm:rounded-2xl"
      >
        <header className="flex items-start gap-3 border-b p-5">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-2xl font-semibold">
              {hasClient && clientLabel
                ? `¿Qué le hiciste a ${clientLabel}?`
                : '¿A quién atendiste?'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {appointment && `Cita de las ${time(appointment.startsAt)} · `}
              {onBehalfOf
                ? `Lo registras a nombre de ${onBehalfOf.name}.`
                : 'Caja lo recibe al instante para cobrarlo.'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-muted"
          >
            <X size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {!appointment && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Clienta</h3>
              {can('clients.read') && (
                <ClientCombobox
                  value={client}
                  onChange={(next) => {
                    setClient(next);
                    if (next) setWalkInName('');
                  }}
                  placeholder="Buscar clienta por nombre o teléfono"
                />
              )}
              {!client && (
                <input
                  value={walkInName}
                  onChange={(event) => setWalkInName(event.target.value)}
                  maxLength={150}
                  aria-label="Nombre de la clienta de paso"
                  placeholder="…o escribe el nombre si es clienta de paso"
                  className="h-12 w-full rounded-xl border bg-background px-3"
                />
              )}
            </section>
          )}

          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Servicios realizados</h3>
              <span className="text-xs text-muted-foreground">{selected.size} marcados</span>
            </div>
            {catalog.length > 10 && (
              <label className="flex h-11 items-center gap-2 rounded-xl border bg-background px-3">
                <Search size={16} className="text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  aria-label="Buscar servicio"
                  placeholder="Buscar servicio"
                  className="w-full bg-transparent outline-none"
                />
              </label>
            )}
            {services.error ? (
              <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
                {services.error.message}
              </p>
            ) : services.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Cargando servicios…
              </p>
            ) : catalog.length === 0 ? (
              <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
                No hay servicios asignados. Pide a la administración que los configure.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {shown.map((service) => {
                  const on = selected.has(service.id);
                  return (
                    <button
                      key={service.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(service.id)}
                      className={cn(
                        'flex min-h-16 items-center gap-3 rounded-xl border p-3 text-left transition active:scale-[0.99]',
                        on ? 'border-primary bg-primary/10' : 'bg-background hover:border-primary',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'grid size-7 shrink-0 place-items-center rounded-full border',
                          on && 'border-primary bg-primary text-primary-foreground',
                        )}
                      >
                        {on && <Check size={16} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{service.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {service.durationMinutes} min · {money(service.priceWithTax)}
                          {booked.has(service.id) && ' · Reservado'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <label className="block text-sm font-semibold">
            Nota para caja <span className="font-normal text-muted-foreground">(opcional)</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Por ejemplo: usó su propio tinte"
              className="mt-1 w-full rounded-xl border bg-background p-3 font-normal"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Total estimado</p>
            <p className="text-xl font-bold tabular-nums">{money(total)}</p>
          </div>
          <Button className="h-12 px-6 text-base" disabled={busy || !selected.size || !hasClient}>
            <Send size={18} />
            {busy ? 'Enviando…' : 'Enviar a caja'}
          </Button>
        </footer>
      </form>
    </div>
  );
}
