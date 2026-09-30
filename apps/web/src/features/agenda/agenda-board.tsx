'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can, useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Plus,
  Scissors,
  TriangleAlert,
  UserCheck,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RegisterServiceDialog } from '@/features/service-tickets/register-service-dialog';
import { STATUS_LABEL, type ServiceTicket } from '@/features/service-tickets/types';
import { PendingRegisterBanner } from '@/features/stylist-day/pending-register-banner';
import { MY_DAY_KEY } from '@/features/stylist-day/use-my-day';
import { loadOptions, loadPage } from '@/lib/pagination';
import type { AgendaClient, Appointment, Service, Stylist } from './types';

type View = 'day' | 'week' | 'month';
const dayMs = 86_400_000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function get<T>(resource: string, params = '') {
  const response = await sessionFetch(`/api/agenda?resource=${resource}${params}`);
  if (!response.ok) throw new Error('No pudimos cargar la agenda.');
  const body = (await response.json()) as { data: T };
  return body.data;
}

export function AgendaBoard({
  initialCreating = false,
  initialClientId,
}: {
  initialCreating?: boolean;
  initialClientId?: string;
}) {
  const { can } = useAccess();
  const canBookAny = can('appointments.create');
  const canBookOwn = can('appointments.create.own');
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(startOfDay(new Date()));
  const [creating, setCreating] = useState(initialCreating);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const [registering, setRegistering] = useState<Appointment | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const grid = new Date(first);
      grid.setDate(1 - first.getDay());
      return Array.from(
        { length: 42 },
        (_, i) => new Date(grid.getFullYear(), grid.getMonth(), grid.getDate() + i),
      );
    }
    const monday = new Date(anchor);
    monday.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
    return Array.from(
      { length: 7 },
      (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i),
    );
  }, [anchor, view]);
  const from = days[0];
  const last = days.at(-1)!;
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  const appointments = useQuery({
    queryKey: ['agenda', from.toISOString(), to.toISOString()],
    queryFn: async () => {
      const ranges: Promise<Appointment[]>[] = [];
      for (let start = from.getTime(); start < to.getTime(); start += 30 * dayMs) {
        const end = Math.min(start + 30 * dayMs, to.getTime());
        ranges.push(
          get<Appointment[]>(
            'calendar',
            '&from=' +
              encodeURIComponent(new Date(start).toISOString()) +
              '&to=' +
              encodeURIComponent(new Date(end).toISOString()),
          ),
        );
      }
      return Array.from(new Map((await Promise.all(ranges)).flat().map((a) => [a.id, a])).values());
    },
  });
  const stylists = useQuery({
    queryKey: ['stylists'],
    enabled: can('stylists.read'),
    queryFn: ({ signal }) => loadOptions<Stylist>('/api/agenda?resource=stylists', signal),
  });
  const services = useQuery({
    queryKey: ['services'],
    enabled: can('services.read'),
    queryFn: ({ signal }) => loadOptions<Service>('/api/agenda?resource=services', signal),
  });
  const clients = useQuery({
    queryKey: ['agenda-clients'],
    enabled: can('clients.read'),
    queryFn: ({ signal }) =>
      loadOptions<AgendaClient>('/api/agenda?resource=clients&sort=name:asc', signal),
  });
  // Con ámbito propio no hay `stylists.read`: la ficha propia se resuelve aparte, sin traer
  // el equipo entero.
  const myStylist = useQuery({
    queryKey: ['my-stylist'],
    enabled: canBookOwn && !canBookAny,
    queryFn: async () => {
      const response = await sessionFetch('/api/stylists/me');
      const body = (await response.json()) as { data: Stylist | null };
      return body.data;
    },
  });
  const clientMap = new Map(clients.data?.map((item) => [item.id, item.fullName]));
  const stylistMap = new Map(stylists.data?.map((item) => [item.id, item]));
  const shift = (direction: number) =>
    setAnchor(
      (date) =>
        new Date(
          date.getFullYear(),
          date.getMonth() + (view === 'month' ? direction : 0),
          view === 'month' ? 1 : date.getDate() + direction * (view === 'week' ? 7 : 1),
        ),
    );
  async function drop(appointment: Appointment, day: Date) {
    setError('');
    const old = new Date(appointment.startsAt);
    const startsAt = new Date(day);
    startsAt.setHours(old.getHours(), old.getMinutes());
    const response = await sessionFetch(`/api/agenda/${appointment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startsAt: startsAt.toISOString() }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { detail?: string };
      setError(body.detail ?? 'El horario entra en conflicto con otra cita.');
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['agenda'] });
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Planificación</p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Agenda</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Arrastra una cita a otro día para reprogramarla.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-xl bg-muted p-1">
            {(['day', 'week', 'month'] as View[]).map((item) => (
              <button
                key={item}
                onClick={() => setView(item)}
                className={`min-h-10 rounded-lg px-4 text-sm font-semibold ${view === item ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
              >
                {item === 'day' ? 'Día' : item === 'week' ? 'Semana' : 'Mes'}
              </button>
            ))}
          </div>
          {(canBookAny || canBookOwn) && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={18} />
              Nueva cita
            </Button>
          )}
        </div>
      </div>
      <PendingRegisterBanner />
      {notice && (
        <p role="status" className="rounded-xl bg-success/10 p-3 text-sm text-success">
          {notice}
        </p>
      )}
      {appointments.isPending && <p role="status">Cargando agenda…</p>}
      {(appointments.error || clients.error || services.error || stylists.error) && (
        <p role="alert">
          No se pudo cargar la agenda completa.{' '}
          <button onClick={() => queryClient.invalidateQueries()}>Reintentar</button>
        </p>
      )}
      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between border-b p-3">
          <button
            onClick={() => shift(-1)}
            aria-label="Anterior"
            className="grid size-11 place-items-center rounded-xl hover:bg-muted"
          >
            <ChevronLeft />
          </button>
          <div className="text-center">
            <button
              onClick={() => setAnchor(startOfDay(new Date()))}
              className="text-sm font-semibold text-primary"
            >
              Hoy
            </button>
            <p className="font-display text-lg font-semibold">
              {anchor.toLocaleDateString('es-GT', { month: 'long', year: 'numeric' })}
            </p>
          </div>
          <button
            onClick={() => shift(1)}
            aria-label="Siguiente"
            className="grid size-11 place-items-center rounded-xl hover:bg-muted"
          >
            <ChevronRight />
          </button>
        </div>
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b bg-danger/10 p-3 text-sm text-danger"
          >
            <TriangleAlert size={17} />
            {error}
          </div>
        )}
        <div
          className={`grid min-w-[760px] ${view === 'day' ? 'grid-cols-1' : view === 'month' ? 'grid-cols-7' : 'grid-cols-7'}`}
        >
          {days.map((day) => (
            <div
              key={day.toISOString()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const item = appointments.data?.find(
                  (a) => a.id === event.dataTransfer.getData('text/plain'),
                );
                if (item && can('appointments.update')) void drop(item, day);
              }}
              className={`border-r border-b p-2 ${view === 'month' ? 'min-h-32' : 'min-h-[560px]'}`}
            >
              <div
                className={`mb-3 text-center text-xs ${isoDay(day) === isoDay(new Date()) ? 'font-bold text-primary' : 'text-muted-foreground'}`}
              >
                <span className="block uppercase">
                  {day.toLocaleDateString('es-GT', { weekday: 'short' })}
                </span>
                <span className="text-lg">{day.getDate()}</span>
              </div>
              <div className="space-y-2">
                {appointments.data
                  ?.filter((a) => isoDay(new Date(a.startsAt)) === isoDay(day))
                  .map((a) => {
                    const stylist = stylistMap.get(a.stylistId);
                    return (
                      <article
                        draggable={can('appointments.update')}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelected(a)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelected(a);
                          }
                        }}
                        onDragStart={(event) => event.dataTransfer.setData('text/plain', a.id)}
                        key={a.id}
                        className="cursor-grab rounded-xl border-l-4 bg-muted p-2 text-xs shadow-sm"
                        style={{ borderLeftColor: stylist?.color ?? 'var(--primary)' }}
                      >
                        <p className="font-bold">
                          {new Date(a.startsAt).toLocaleTimeString('es-GT', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                        <p className="mt-1 truncate font-semibold">
                          {a.clientName ?? clientMap.get(a.clientId) ?? 'Clienta'}
                        </p>
                        <p className="truncate text-muted-foreground">
                          {stylist?.displayName ?? 'Estilista'}
                        </p>
                      </article>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </Card>
      {creating && (canBookAny || canBookOwn) && (
        <BookingForm
          initialClientId={initialClientId}
          clients={clients.data ?? []}
          stylists={stylists.data ?? []}
          services={services.data ?? []}
          ownStylist={canBookOwn && !canBookAny ? myStylist.data : undefined}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await queryClient.invalidateQueries({ queryKey: ['agenda'] });
          }}
        />
      )}
      {selected && (
        <AppointmentActions
          appointment={selected}
          clientName={selected.clientName ?? clientMap.get(selected.clientId) ?? 'Clienta'}
          stylists={stylists.data ?? []}
          onClose={() => setSelected(null)}
          onRegister={() => {
            setRegistering(selected);
            setSelected(null);
          }}
          onSaved={async () => {
            setSelected(null);
            await queryClient.invalidateQueries({ queryKey: ['agenda'] });
          }}
        />
      )}
      {registering && (
        <RegisterServiceDialog
          appointment={registering}
          // Quien puede registrar por otras lo hace a nombre de la profesional de la cita:
          // la comanda y la comisión son de ella, no de quien teclea.
          onBehalfOf={
            can('service-tickets.create')
              ? {
                  stylistId: registering.stylistId,
                  name: stylistMap.get(registering.stylistId)?.displayName ?? 'la profesional',
                }
              : undefined
          }
          onClose={() => setRegistering(null)}
          onDone={async (ticket) => {
            setRegistering(null);
            setNotice(`Enviado a caja: ${ticket.clientName}. La cita queda completada.`);
            await Promise.all(
              [['agenda'], ['agenda-tickets'], MY_DAY_KEY, ['service-tickets-pending-count']].map(
                (queryKey) => queryClient.invalidateQueries({ queryKey }),
              ),
            );
          }}
        />
      )}
    </div>
  );
}

const dayBounds = (iso: string) => {
  const date = new Date(iso);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
};

function AppointmentActions({
  appointment,
  clientName,
  stylists,
  onClose,
  onRegister,
  onSaved,
}: {
  appointment: Appointment;
  clientName: string;
  stylists: Stylist[];
  onClose: () => void;
  onRegister: () => void;
  onSaved: () => void;
}) {
  const { can } = useAccess();
  const [stylistId, setStylistId] = useState(appointment.stylistId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isCancelled = appointment.status === 'CANCELLED';
  const canRegister = can('service-tickets.create') || can('service-tickets.create.own');
  const canStart = can('appointments.update') || can('appointments.update.own');
  // ¿Ya se envió a caja? Se mira en las comandas del día de la cita.
  const tickets = useQuery({
    queryKey: ['agenda-tickets', dayBounds(appointment.startsAt)],
    enabled: can('service-tickets.read') || can('service-tickets.read.own'),
    queryFn: ({ signal }) =>
      loadPage<ServiceTicket>(
        `/api/service-tickets?limit=100&${dayBounds(appointment.startsAt)}`,
        signal,
      ).then((page) => page.data),
  });
  const ticket = tickets.data?.find(
    (item) => item.appointmentId === appointment.id && item.status !== 'CANCELLED',
  );
  const attendable = !isCancelled && appointment.status !== 'NO_SHOW';
  async function act(action: 'reschedule' | 'cancel' | 'start') {
    setBusy(true);
    setError('');
    const response = await sessionFetch(
      `/api/agenda/${appointment.id}${action === 'reschedule' ? '' : `?action=${action}`}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'cancel'
            ? { reason: reason || undefined }
            : action === 'start'
              ? {}
              : { stylistId },
        ),
      },
    );
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json()) as { detail?: string; message?: string };
      setError(body.detail ?? body.message ?? 'No pudimos actualizar la cita.');
      return;
    }
    onSaved();
  }
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="appointment-actions-title"
    >
      <div className="w-full max-w-md space-y-5 rounded-2xl bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 id="appointment-actions-title" className="font-display text-2xl font-semibold">
              {clientName}
            </h2>
            <p className="text-sm text-muted-foreground">
              {new Date(appointment.startsAt).toLocaleString('es-GT', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          <button onClick={onClose} aria-label="Cerrar">
            <X />
          </button>
        </div>
        {attendable && canRegister && (
          <div className="space-y-2">
            {ticket ? (
              <p className="flex items-center gap-2 rounded-xl bg-success/10 p-3 text-sm font-medium text-success">
                <CheckCircle2 size={16} />
                Enviado a caja · {STATUS_LABEL[ticket.status]}
              </p>
            ) : (
              <Button className="h-12 w-full" disabled={busy} onClick={onRegister}>
                <Scissors size={17} />
                Registrar lo realizado
              </Button>
            )}
            {!ticket &&
              canStart &&
              (appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED') && (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={busy}
                  onClick={() => act('start')}
                >
                  <UserCheck size={17} />
                  Llegó: iniciar atención
                </Button>
              )}
          </div>
        )}
        {/* Cada bloque entero va tras su permiso: un selector sin botón no sirve a nadie. */}
        <Can permission="appointments.update">
          <label className="block text-sm font-semibold">
            Cambiar estilista
            <select
              aria-label="Cambiar estilista"
              value={stylistId}
              onChange={(e) => setStylistId(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-xl border bg-background px-3"
            >
              {stylists
                .filter((x) => x.isBookable)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.displayName}
                  </option>
                ))}
            </select>
          </label>
          <Button
            className="w-full"
            disabled={busy || stylistId === appointment.stylistId}
            onClick={() => act('reschedule')}
          >
            Guardar estilista
          </Button>
        </Can>
        <Can permission="appointments.cancel">
          <div className="border-t pt-5">
            <label className="block text-sm font-semibold">
              Motivo de cancelación
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-xl border bg-background px-3"
              />
            </label>
            <Button
              variant="outline"
              className="mt-3 w-full text-danger"
              disabled={busy || isCancelled}
              onClick={() => act('cancel')}
            >
              {isCancelled ? 'Cita ya cancelada' : 'Cancelar cita'}
            </Button>
          </div>
        </Can>
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function BookingForm({
  initialClientId,
  clients,
  stylists,
  services,
  ownStylist,
  onClose,
  onSaved,
}: {
  initialClientId?: string;
  clients: AgendaClient[];
  stylists: Stylist[];
  services: Service[];
  /** Con ámbito propio: la ficha a bloquear, `null` si no tiene una vinculada, `undefined` si no aplica. */
  ownStylist?: Stylist | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const clientId = String(data.get('clientId') ?? '');
    const stylistId = String(data.get('stylistId') ?? '');
    const serviceIds = data.getAll('serviceIds');
    if (!uuidPattern.test(clientId) || !uuidPattern.test(stylistId)) {
      setBusy(false);
      setError(
        'Selecciona una clienta y una estilista válidas. Recarga la página si el problema continúa.',
      );
      return;
    }
    if (serviceIds.length === 0) {
      setBusy(false);
      setError('Selecciona al menos un servicio.');
      return;
    }
    const response = await sessionFetch('/api/agenda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        stylistId,
        startsAt: new Date(String(data.get('startsAt'))).toISOString(),
        serviceIds,
        source: 'STAFF',
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json()) as {
        detail?: string;
        message?: string;
        errors?: { message: string }[];
      };
      setError(
        body.errors?.map((item) => item.message).join('. ') ??
          body.detail ??
          body.message ??
          'No pudimos reservar la cita.',
      );
      return;
    }
    onSaved();
  }
  const field = 'h-11 w-full rounded-xl border bg-background px-3 text-sm';
  const dialogRef = useDialog(onClose);
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Nueva cita"
      className="fixed inset-0 z-50 grid place-items-end bg-black/40 sm:place-items-center sm:p-6"
    >
      <form
        onSubmit={submit}
        onChange={() => error && setError('')}
        className="w-full max-w-xl space-y-4 rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex justify-between">
          <h2 className="font-display text-2xl font-semibold">Nueva cita</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X />
          </button>
        </div>
        <label className="block text-sm font-semibold">
          Clienta
          <select
            // Las opciones llegan de una consulta aparte y no están listas en el primer
            // render: sin la `key`, React aplica `defaultValue` contra una lista vacía y no
            // vuelve a intentarlo cuando las clientas llegan, dejando el selector en
            // "Selecciona…" pese a venir de la ficha de una clienta concreta.
            key={clients.length}
            required
            defaultValue={initialClientId ?? ''}
            name="clientId"
            className={`${field} mt-1.5`}
          >
            <option value="">Selecciona…</option>
            {clients.map((x) => (
              <option key={x.id} value={x.id}>
                {x.fullName}
              </option>
            ))}
          </select>
        </label>
        {ownStylist !== undefined ? (
          <label className="block text-sm font-semibold">
            Estilista
            {ownStylist ? (
              <>
                <p className={`${field} mt-1.5 flex items-center bg-muted text-muted-foreground`}>
                  {ownStylist.displayName} (tú)
                </p>
                <input type="hidden" name="stylistId" value={ownStylist.id} />
              </>
            ) : (
              <p role="alert" className="mt-1.5 text-sm text-danger">
                Tu cuenta no tiene una ficha de profesional vinculada. Pide a la propietaria que la
                enlace antes de agendar.
              </p>
            )}
          </label>
        ) : (
          <label className="block text-sm font-semibold">
            Estilista
            <select required name="stylistId" className={`${field} mt-1.5`}>
              <option value="">Selecciona…</option>
              {stylists
                .filter((x) => x.isBookable)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.displayName}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="block text-sm font-semibold">
          Fecha y hora
          <input required name="startsAt" type="datetime-local" className={`${field} mt-1.5`} />
        </label>
        <fieldset>
          <legend className="text-sm font-semibold">Servicios</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {services
              .filter((x) => x.isBookable)
              .map((x) => (
                <label key={x.id} className="flex gap-2 rounded-xl border p-3 text-sm">
                  <input type="checkbox" name="serviceIds" value={x.id} />
                  <span>
                    {x.name}
                    <small className="block text-muted-foreground">
                      {x.blockedMinutes} min · {x.priceWithTax} {x.currency}
                    </small>
                  </span>
                </label>
              ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy}>{busy ? 'Reservando…' : 'Reservar cita'}</Button>
        </div>
      </form>
    </div>
  );
}
