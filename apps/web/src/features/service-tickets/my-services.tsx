'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Scissors, Send, XCircle } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { loadOptions, loadPage } from '@/lib/pagination';
import { sessionFetch } from '@/lib/session-fetch';
import type { AgendaClient, Appointment } from '@/features/agenda/types';
import { money, problem, STATUS_LABEL, type AssignableService, type ServiceTicket } from './types';

const WALK_IN = '__walk_in__';
const ATTENDABLE = new Set(['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED']);

const today = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

/**
 * Módulo de la profesional: registra los servicios que realizó para que caja los cobre.
 *
 * Solo ofrece los servicios que la administración le asignó (el servidor lo vuelve a
 * comprobar). Si la visita viene de una cita de hoy, basta con elegirla: la clienta y los
 * servicios se rellenan solos y la cita queda completada al enviarla.
 */
export function MyServices() {
  const qc = useQueryClient();
  const { can } = useAccess();
  const [range] = useState(today);
  const [appointmentId, setAppointmentId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const services = useQuery({
    queryKey: ['assignable-services'],
    queryFn: async () => {
      const r = await sessionFetch('/api/service-tickets/assignable');
      if (!r.ok) throw new Error(await problem(r, 'No se pudieron cargar tus servicios.'));
      return ((await r.json()) as { data: AssignableService[] }).data;
    },
  });
  const clients = useQuery({
    queryKey: ['my-services-clients'],
    enabled: can('clients.read'),
    queryFn: ({ signal }) =>
      loadOptions<AgendaClient>('/api/agenda?resource=clients&sort=name:asc', signal),
  });
  const appointments = useQuery({
    queryKey: ['my-services-appointments', range.from],
    enabled: can('appointments.read.own') || can('appointments.read'),
    queryFn: async () => {
      const r = await sessionFetch(
        `/api/agenda?resource=calendar&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      );
      if (!r.ok) return [];
      return ((await r.json()) as { data: Appointment[] }).data.filter((a) =>
        ATTENDABLE.has(a.status),
      );
    },
  });
  const tickets = useQuery({
    queryKey: ['my-service-tickets', range.from],
    // Así la profesional ve pasar a «Cobrado» lo que caja va cobrando.
    refetchInterval: 30_000,
    queryFn: ({ signal }) =>
      loadPage<ServiceTicket>(
        `/api/service-tickets?limit=100&sort=createdAt:desc&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
        signal,
      ),
  });

  const clientNames = new Map(clients.data?.map((c) => [c.id, c.fullName]));
  const registered = new Set(
    tickets.data?.data.filter((t) => t.status !== 'CANCELLED').map((t) => t.appointmentId),
  );
  const openAppointments = (appointments.data ?? []).filter((a) => !registered.has(a.id));
  const catalog = services.data ?? [];
  const total = catalog
    .filter((s) => selected.includes(s.id))
    .reduce((sum, s) => sum + Number(s.priceWithTax), 0);

  function chooseAppointment(id: string) {
    setAppointmentId(id);
    setNotice(null);
    const appointment = appointments.data?.find((a) => a.id === id);
    if (!appointment) return;
    setClientId(appointment.clientId);
    const offered = new Set(catalog.map((s) => s.id));
    setSelected(appointment.services.map((s) => s.serviceId).filter((sid) => offered.has(sid)));
  }

  function toggle(id: string) {
    setSelected((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  }

  function reset() {
    setAppointmentId('');
    setClientId('');
    setClientName('');
    setSelected([]);
    setNotes('');
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const walkIn = clientId === WALK_IN;
    const r = await sessionFetch('/api/service-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceIds: selected,
        appointmentId: appointmentId || undefined,
        clientId: walkIn || !clientId ? undefined : clientId,
        clientName: walkIn ? clientName : undefined,
        notes: notes || undefined,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setNotice({ kind: 'error', text: await problem(r, 'No pudimos registrar el servicio.') });
      return;
    }
    const { data } = (await r.json()) as { data: ServiceTicket };
    setNotice({
      kind: 'success',
      text: `Enviado a caja: ${data.clientName} · ${money(data.total)}`,
    });
    reset();
    await qc.invalidateQueries({ queryKey: ['my-service-tickets'] });
    await qc.invalidateQueries({ queryKey: ['my-services-appointments'] });
  }

  const canSubmit =
    selected.length > 0 &&
    (clientId === WALK_IN ? clientName.trim().length > 0 : clientId !== '') &&
    !busy;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h2 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <Scissors size={22} className="text-primary" />
          Registrar servicio realizado
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Indica a qué clienta atendiste y qué le hiciste. Caja lo recibirá al instante para
          cobrarlo.
        </p>

        {services.error && (
          <p role="alert" className="mt-4 rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {services.error.message}
          </p>
        )}

        <form onSubmit={submit} className="mt-5 space-y-5">
          {openAppointments.length > 0 && (
            <label className="block text-sm font-semibold">
              Cita de hoy (opcional)
              <select
                value={appointmentId}
                onChange={(e) => chooseAppointment(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border bg-background px-3 font-normal"
              >
                <option value="">Sin cita — clienta sin reserva</option>
                {openAppointments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {time(a.startsAt)} · {clientNames.get(a.clientId) ?? 'Clienta'}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              Clienta
              <select
                required
                value={clientId}
                disabled={!!appointmentId}
                onChange={(e) => setClientId(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border bg-background px-3 font-normal"
              >
                <option value="">Selecciona la clienta…</option>
                <option value={WALK_IN}>Clienta de paso (sin ficha)</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                  </option>
                ))}
              </select>
            </label>
            {clientId === WALK_IN && (
              <label className="block text-sm font-semibold">
                Nombre de la clienta
                <input
                  required
                  maxLength={150}
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="mt-1 h-11 w-full rounded-xl border bg-background px-3 font-normal"
                />
              </label>
            )}
          </div>

          <fieldset>
            <legend className="text-sm font-semibold">Servicios realizados</legend>
            {services.isPending ? (
              <p className="mt-2 text-sm text-muted-foreground">Cargando tus servicios…</p>
            ) : catalog.length === 0 ? (
              <p className="mt-2 rounded-xl bg-secondary p-3 text-sm">
                Aún no tienes servicios asignados. Pide a la administración que los configure.
              </p>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {catalog.map((s) => {
                  const active = selected.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${active ? 'border-primary bg-secondary' : 'hover:border-primary'}`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggle(s.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{s.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {s.durationMinutes} min · {money(s.priceWithTax)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <label className="block text-sm font-semibold">
            Observaciones para caja (opcional)
            <textarea
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-xl border bg-background p-3 font-normal"
            />
          </label>

          {notice && (
            <p
              role={notice.kind === 'error' ? 'alert' : 'status'}
              className={`rounded-xl p-3 text-sm ${notice.kind === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}
            >
              {notice.text}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-lg font-bold">
              Total estimado: <span>{money(total)}</span>
            </p>
            <Button disabled={!canSubmit}>
              <Send size={17} />
              {busy ? 'Enviando…' : 'Enviar a caja'}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b p-5">
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
            <ClipboardList size={20} />
            Mis servicios de hoy
          </h2>
        </div>
        {tickets.error && (
          <p role="alert" className="p-5 text-sm">
            No se pudieron cargar tus servicios.{' '}
            <button onClick={() => tickets.refetch()}>Reintentar</button>
          </p>
        )}
        {tickets.data?.data.length ? (
          <div className="divide-y">
            {tickets.data.data.map((t) => (
              <TicketRow key={t.id} ticket={t} />
            ))}
          </div>
        ) : (
          !tickets.isPending && (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Todavía no has registrado servicios hoy.
            </p>
          )
        )}
      </Card>
    </div>
  );
}

function TicketRow({ ticket }: { ticket: ServiceTicket }) {
  const qc = useQueryClient();
  const { can } = useAccess();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const tone =
    ticket.status === 'CHARGED'
      ? 'bg-success/10 text-success'
      : ticket.status === 'PENDING'
        ? 'bg-warning/10 text-warning'
        : 'bg-muted text-muted-foreground';

  async function cancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await sessionFetch(`/api/service-tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) return setError(await problem(r, 'No pudimos anular el servicio.'));
    setCancelling(false);
    await qc.invalidateQueries({ queryKey: ['my-service-tickets'] });
  }

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">{time(ticket.createdAt)}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{ticket.clientName}</p>
          <p className="text-sm text-muted-foreground">
            {ticket.lines.map((l) => l.name).join(', ')}
          </p>
        </div>
        <strong>{money(ticket.total)}</strong>
        <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs ${tone}`}>
          {ticket.status === 'CHARGED' && <CheckCircle2 size={13} />}
          {ticket.status === 'CANCELLED' && <XCircle size={13} />}
          {STATUS_LABEL[ticket.status]}
        </span>
        {ticket.status === 'PENDING' &&
          (can('service-tickets.cancel.own') || can('service-tickets.cancel')) &&
          !cancelling && (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              Anular
            </Button>
          )}
      </div>
      {cancelling && (
        <form onSubmit={cancel} className="mt-3 flex flex-wrap gap-2">
          <input
            required
            minLength={3}
            maxLength={250}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Motivo de la anulación"
            aria-label="Motivo de la anulación"
            className="h-10 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm"
          />
          <Button variant="outline">Confirmar anulación</Button>
          <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>
            Volver
          </Button>
          {error && (
            <p role="alert" className="w-full text-xs text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
