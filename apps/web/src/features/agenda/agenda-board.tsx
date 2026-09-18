'use client';
import { useDialog } from '@/lib/use-dialog';
import { Can, useAccess } from '@/components/session-access';
import { sessionFetch } from '@/lib/session-fetch';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { loadOptions } from '@/lib/pagination';
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
  const [error, setError] = useState('');
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
                          {clientMap.get(a.clientId) ?? 'Clienta'}
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
          stylists={stylists.data ?? []}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null);
            await queryClient.invalidateQueries({ queryKey: ['agenda'] });
          }}
        />
      )}
    </div>
  );
}

function AppointmentActions({
  appointment,
  stylists,
  onClose,
  onSaved,
}: {
  appointment: Appointment;
  stylists: Stylist[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [stylistId, setStylistId] = useState(appointment.stylistId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isCancelled = appointment.status === 'CANCELLED';
  async function act(action: 'reschedule' | 'cancel') {
    setBusy(true);
    setError('');
    const response = await sessionFetch(
      `/api/agenda/${appointment.id}${action === 'cancel' ? '?action=cancel' : ''}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'cancel' ? { reason: reason || undefined } : { stylistId }),
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
          <h2 id="appointment-actions-title" className="font-display text-2xl font-semibold">
            Gestionar cita
          </h2>
          <button onClick={onClose} aria-label="Cerrar">
            <X />
          </button>
        </div>
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
        <Can permission="appointments.update">
          <Button
            className="w-full"
            disabled={busy || stylistId === appointment.stylistId}
            onClick={() => act('reschedule')}
          >
            Guardar estilista
          </Button>
        </Can>
        <div className="border-t pt-5">
          <label className="block text-sm font-semibold">
            Motivo de cancelación
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-xl border bg-background px-3"
            />
          </label>
          <Can permission="appointments.cancel">
            <Button
              variant="outline"
              className="mt-3 w-full text-danger"
              disabled={busy || isCancelled}
              onClick={() => act('cancel')}
            >
              {isCancelled ? 'Cita ya cancelada' : 'Cancelar cita'}
            </Button>
          </Can>
        </div>
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
