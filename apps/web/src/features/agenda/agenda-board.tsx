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
  UserX,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ClientCombobox, type PosClient } from '@/features/sales/client-combobox';
import { RegisterServiceDialog } from '@/features/service-tickets/register-service-dialog';
import { STATUS_LABEL, type ServiceTicket } from '@/features/service-tickets/types';
import { PendingRegisterBanner } from '@/features/stylist-day/pending-register-banner';
import { MY_DAY_KEY } from '@/features/stylist-day/use-my-day';
import { loadOptions, loadPage } from '@/lib/pagination';
import {
  APPOINTMENT_STATUS_LABEL,
  FINAL_APPOINTMENT_STATUSES,
  type Appointment,
  type Service,
  type Stylist,
} from './types';
import { money } from '@/lib/utils';
import { LoadError } from '@/components/ui/states';
import { DialogClose } from '@/components/ui/dialog-close';

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
      {(appointments.error || services.error || stylists.error) && (
        <LoadError
          message="No se pudo cargar la agenda completa."
          // Solo lo de la agenda: invalidar todo recargaría también caja, ventas y demás.
          onRetry={() => {
            void appointments.refetch();
            void services.refetch();
            void stylists.refetch();
          }}
        />
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
                    // Una cita cancelada o a la que no vinieron no ocupa el hueco: se ve
                    // atenuada para que recepción no la tome por una reserva vigente.
                    const gone = a.status === 'CANCELLED' || a.status === 'NO_SHOW';
                    return (
                      <article
                        draggable={
                          can('appointments.update') && !FINAL_APPOINTMENT_STATUSES.has(a.status)
                        }
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
                        className={`cursor-grab rounded-xl border-l-4 bg-muted p-2 text-xs shadow-sm ${gone ? 'opacity-60' : ''}`}
                        style={{ borderLeftColor: stylist?.color ?? 'var(--primary)' }}
                      >
                        <p className="flex items-center justify-between gap-1 font-bold">
                          {new Date(a.startsAt).toLocaleTimeString('es-GT', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {a.status !== 'SCHEDULED' && (
                            <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold">
                              {APPOINTMENT_STATUS_LABEL[a.status] ?? a.status}
                            </span>
                          )}
                        </p>
                        <p className={`mt-1 truncate font-semibold ${gone ? 'line-through' : ''}`}>
                          {a.clientName ?? 'Clienta'}
                        </p>
                        <p className="truncate text-muted-foreground">
                          {stylist?.displayName ?? 'Profesional'}
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
          clientName={selected.clientName ?? 'Clienta'}
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
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isCancelled = appointment.status === 'CANCELLED';
  const isFinal = FINAL_APPOINTMENT_STATUSES.has(appointment.status);
  const isUpcoming = appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED';
  // «No vino» solo una vez pasada la hora: antes sería prejuzgar, y la API lo rechaza.
  // La hora se toma al abrir el diálogo, no en cada render.
  const [openedAt] = useState(() => Date.now());
  const hasStarted = new Date(appointment.startsAt).getTime() <= openedAt;
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
  async function act(
    action: 'reschedule' | 'cancel' | 'start' | 'confirm' | 'complete' | 'no-show',
    startsAt?: string,
  ) {
    setBusy(true);
    setError('');
    const response = await sessionFetch(
      `/api/agenda/${appointment.id}${action === 'reschedule' ? '' : `?action=${action}`}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'cancel'
            ? { reason: reason.trim() || undefined }
            : action === 'reschedule'
              ? startsAt
                ? { startsAt }
                : { stylistId }
              : {},
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
      <div className="max-h-[92dvh] w-full max-w-md space-y-5 overflow-y-auto rounded-2xl bg-card p-6">
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
            <p className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
              {APPOINTMENT_STATUS_LABEL[appointment.status] ?? appointment.status}
            </p>
          </div>
          <DialogClose onClose={onClose} />
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
            {!ticket && canStart && isUpcoming && (
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
        {/* Cerrar la cita sin comanda: lo que se cobró directo en el punto de venta. */}
        {!isFinal && !ticket && canStart && (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => act('complete')}
          >
            <CheckCircle2 size={17} />
            Marcar como realizada
          </Button>
        )}
        <Can permission="appointments.update">
          {(appointment.status === 'SCHEDULED' || (isUpcoming && hasStarted)) && (
            <div className="grid gap-2 sm:grid-cols-2">
              {appointment.status === 'SCHEDULED' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act('confirm')}
                  className={hasStarted ? '' : 'sm:col-span-2'}
                >
                  Confirmar con la clienta
                </Button>
              )}
              {isUpcoming && hasStarted && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act('no-show')}
                  className={appointment.status === 'SCHEDULED' ? '' : 'sm:col-span-2'}
                >
                  <UserX size={17} />
                  No vino
                </Button>
              )}
            </div>
          )}
        </Can>
        {/* Cada bloque entero va tras su permiso: un selector sin botón no sirve a nadie. */}
        <Can permission="appointments.update">
          {!isFinal && (
            <>
              <label className="block text-sm font-semibold">
                Cambiar profesional
                <select
                  aria-label="Cambiar profesional"
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
                Guardar profesional
              </Button>
              <RescheduleSection
                appointment={appointment}
                busy={busy}
                onMove={(startsAt) => act('reschedule', startsAt)}
              />
            </>
          )}
        </Can>
        {/* Cancelar es irreversible: pide confirmar, como anular una venta. */}
        <Can permission="appointments.cancel">
          {!isFinal &&
            (confirmingCancel ? (
              <div className="space-y-3 rounded-xl border border-danger/40 bg-danger/5 p-4">
                <p className="text-sm font-semibold">
                  ¿Cancelar la cita de {clientName}? Se libera el hueco y no se puede deshacer: si
                  vuelve a llamar, se reserva una nueva.
                </p>
                <label className="block text-sm font-semibold">
                  Motivo (opcional)
                  <input
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1.5 h-11 w-full rounded-xl border bg-background px-3"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmingCancel(false)}
                  >
                    Volver
                  </Button>
                  <Button
                    className="bg-danger text-white hover:bg-danger/90"
                    disabled={busy}
                    onClick={() => act('cancel')}
                  >
                    Sí, cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="border-t pt-5">
                <Button
                  variant="outline"
                  className="w-full text-danger"
                  disabled={busy}
                  onClick={() => setConfirmingCancel(true)}
                >
                  Cancelar cita
                </Button>
              </div>
            ))}
        </Can>
        {isFinal && (
          <p className="text-sm text-muted-foreground">
            {isCancelled
              ? 'La cita está cancelada. Si la clienta vuelve a llamar, reserva una nueva.'
              : 'La cita ya terminó: no admite más cambios.'}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

type Slot = { startsAt: string; endsAt: string; durationMinutes: number };

const hourOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

/**
 * Mover la cita a otro día u otra hora con la misma profesional.
 *
 * Ofrece los huecos que calcula la API —horario, ausencias, otras citas y limpieza—, para
 * que recepción no tenga que adivinar a prueba y error. Arrastrar en el calendario cambia
 * el día pero no la hora, y en un teléfono no se puede arrastrar.
 */
function RescheduleSection({
  appointment,
  busy,
  onMove,
}: {
  appointment: Appointment;
  busy: boolean;
  onMove: (startsAt: string) => void;
}) {
  const [day, setDay] = useState(() => isoDay(new Date(appointment.startsAt)));
  const [chosen, setChosen] = useState<string | null>(null);
  const serviceIds = appointment.services.map((item) => item.serviceId).join(',');
  const slots = useQuery({
    queryKey: ['availability', appointment.stylistId, day, serviceIds],
    enabled: Boolean(day && serviceIds),
    queryFn: async () => {
      const params = new URLSearchParams({
        resource: 'availability',
        stylistId: appointment.stylistId,
        date: day,
        serviceIds,
      });
      const response = await sessionFetch(`/api/agenda?${params}`);
      if (!response.ok) throw new Error('No pudimos consultar los huecos libres.');
      return ((await response.json()) as { data: Slot[] }).data;
    },
  });
  return (
    <div className="space-y-3 border-t pt-5">
      <label className="block text-sm font-semibold">
        Cambiar fecha y hora
        <input
          type="date"
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            setChosen(null);
          }}
          className="mt-1.5 h-11 w-full rounded-xl border bg-background px-3"
        />
      </label>
      {slots.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Buscando horas libres…
        </p>
      ) : slots.error ? (
        <p role="alert" className="text-sm text-danger">
          {slots.error.message}
        </p>
      ) : slots.data?.length ? (
        <div role="group" aria-label="Horas libres" className="flex flex-wrap gap-2">
          {slots.data.map((slot) => (
            <button
              key={slot.startsAt}
              type="button"
              aria-pressed={chosen === slot.startsAt}
              onClick={() => setChosen(slot.startsAt)}
              className={`h-10 rounded-lg border px-3 text-sm font-semibold tabular-nums ${chosen === slot.startsAt ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {hourOf(slot.startsAt)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Ese día no hay horas libres con esta profesional.
        </p>
      )}
      <Button
        className="w-full"
        disabled={busy || !chosen}
        onClick={() => chosen && onMove(chosen)}
      >
        {chosen ? `Mover a las ${hourOf(chosen)}` : 'Elige una hora'}
      </Button>
    </div>
  );
}

function BookingForm({
  initialClientId,
  stylists,
  services,
  ownStylist,
  onClose,
  onSaved,
}: {
  initialClientId?: string;
  stylists: Stylist[];
  services: Service[];
  /** Con ámbito propio: la ficha a bloquear, `null` si no tiene una vinculada, `undefined` si no aplica. */
  ownStylist?: Stylist | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // La clienta se busca en el servidor, como en el punto de venta: cargarlas todas para un
  // `<select>` deja de servir en cuanto el salón pasa de unas decenas. Si se llega desde
  // la ficha de una clienta, viene ya elegida; `undefined` es «aún no la tocaron».
  const [picked, setPicked] = useState<PosClient | null | undefined>(undefined);
  const initialClient = useQuery({
    queryKey: ['booking-client', initialClientId],
    enabled: Boolean(initialClientId),
    queryFn: async () => {
      const response = await sessionFetch(`/api/clients/${encodeURIComponent(initialClientId!)}`);
      if (!response.ok) return null;
      return ((await response.json()) as { data: PosClient }).data;
    },
  });
  const client = picked === undefined ? (initialClient.data ?? null) : picked;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const clientId = client?.id ?? '';
    const stylistId = String(data.get('stylistId') ?? '');
    const serviceIds = data.getAll('serviceIds');
    if (!uuidPattern.test(clientId) || !uuidPattern.test(stylistId)) {
      setBusy(false);
      setError(
        client ? 'Selecciona la profesional que la atenderá.' : 'Busca y elige a la clienta.',
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
        // Con muchos servicios el formulario no cabe en un teléfono: se desplaza dentro.
        className="max-h-[92dvh] w-full max-w-xl space-y-4 overflow-y-auto rounded-t-3xl bg-card p-6 sm:rounded-2xl"
      >
        <div className="flex justify-between">
          <h2 className="font-display text-2xl font-semibold">Nueva cita</h2>
          <DialogClose onClose={onClose} />
        </div>
        <div className="space-y-1.5 text-sm font-semibold">
          <span>Clienta</span>
          <ClientCombobox
            value={client}
            onChange={setPicked}
            label="Clienta"
            placeholder="Buscar por nombre o teléfono"
          />
        </div>
        {ownStylist !== undefined ? (
          <label className="block text-sm font-semibold">
            Profesional
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
            Profesional
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
                      {x.blockedMinutes} min · {money(x.priceWithTax)}
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
