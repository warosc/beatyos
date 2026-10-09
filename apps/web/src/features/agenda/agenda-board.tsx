'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellRing,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  List,
  Plus,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { RegisterServiceDialog } from '@/features/service-tickets/register-service-dialog';
import { PendingRegisterBanner } from '@/features/stylist-day/pending-register-banner';
import { MY_DAY_KEY } from '@/features/stylist-day/use-my-day';
import { cn, money } from '@/lib/utils';
import { agendaGet, agendaSend } from './api';
import { AppointmentSheet } from './appointment-sheet';
import { BlockDetail, SlotChoice } from './block-dialogs';
import { BookingWizard } from './booking-wizard';
import { ChangeRequestsInbox } from './change-requests';
import { isActive, statusMeta } from './status';
import {
  addDays,
  dayLabel,
  isoDay,
  minutesInDay,
  parseIsoDay,
  plural,
  sameDay,
  startOfDay,
  startOfWeek,
  time,
  visibleHours,
} from './time';
import { TimeGrid, type GridColumn } from './time-grid';
import type { Appointment, StylistShifts } from './types';
import {
  AGENDA_KEY,
  PENDING_CHANGES_KEY,
  usePendingChanges,
  useAgendaRange,
  useServiceCatalog,
} from './use-agenda';

type View = 'day' | 'week' | 'month' | 'list';

const VIEWS: { value: View; label: string }[] = [
  { value: 'day', label: 'Día' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'list', label: 'Lista' },
];

const VIEW_STORAGE = 'beautyos-agenda-view';

const readView = (): View => {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE);
    if (saved && VIEWS.some((view) => view.value === saved)) return saved as View;
  } catch {
    /* Sin almacenamiento: vista por defecto. */
  }
  return 'day';
};

/**
 * La agenda del salón.
 *
 * Una sola pantalla para dos maneras de mirar el día: la encargada y recepción ven a todo
 * el equipo en columnas —quién está libre, qué falta confirmar, qué pidió mover alguien—, y
 * la profesional ve la suya con las mismas herramientas. Lo que cambia según quién mira lo
 * deciden los permisos, no pantallas distintas.
 *
 * Se mantiene al día sola: un canal en vivo avisa de cada cambio y, por si se pierde, la
 * agenda vuelve a pedirse cada minuto.
 */
export function AgendaBoard({
  initialCreating = false,
  initialClientId,
}: {
  initialCreating?: boolean;
  initialClientId?: string;
}) {
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const canBookAny = can('appointments.create');
  const canBookOwn = can('appointments.create.own');
  const canApprove = can('appointments.approve-changes');
  const canManageSchedule = can('stylists.manage-schedule');
  const canUpdate = can('appointments.update');
  const ownOnly = !can('appointments.read') && can('appointments.read.own');

  // La agenda solo se pinta en el cliente —el menú espera a comprobar la sesión—, así que
  // se puede leer la vista guardada en el estado inicial sin desajuste de hidratación.
  const [view, setViewState] = useState<View>(readView);
  const setView = (next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_STORAGE, next);
    } catch {
      /* Recordarla es una comodidad, no un requisito. */
    }
  };

  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showCancelled, setShowCancelled] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // La clienta de la ficha solo vale para la cita con la que se llegó, no para las siguientes.
  const [booking, setBooking] = useState<{
    day?: Date;
    stylistId?: string;
    startsAt?: string;
    clientId?: string;
  } | null>(initialCreating ? { clientId: initialClientId } : null);
  const [choice, setChoice] = useState<{ column: GridColumn; startsAt: Date } | null>(null);
  const [block, setBlock] = useState<{
    id: string;
    stylistId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
  } | null>(null);
  const [registering, setRegistering] = useState<Appointment | null>(null);
  const [inbox, setInbox] = useState(false);
  const [reminders, setReminders] = useState(false);

  // Rango que se pide a la API según la vista.
  const { from, days } = useMemo(() => {
    if (view === 'week') return { from: startOfWeek(anchor), days: 7 };
    if (view === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      return { from: startOfWeek(first), days: 42 };
    }
    return { from: anchor, days: 1 };
  }, [anchor, view]);

  const { calendar, shifts } = useAgendaRange(from, days);
  const services = useServiceCatalog(canBookAny || canBookOwn);
  const pending = usePendingChanges(canApprove);
  const team = useMemo(() => shifts.data ?? [], [shifts.data]);
  const visibleTeam = team.filter((member) => !hidden.has(member.stylistId));

  const appointments = useMemo(
    () =>
      (calendar.data ?? [])
        .filter((item) => !hidden.has(item.stylistId))
        .filter((item) => showCancelled || item.status !== 'CANCELLED'),
    [calendar.data, hidden, showCancelled],
  );
  const selected = calendar.data?.find((item) => item.id === selectedId) ?? null;

  const shift = (direction: number) =>
    setAnchor((date) =>
      view === 'month'
        ? new Date(date.getFullYear(), date.getMonth() + direction, 1)
        : addDays(date, direction * (view === 'week' ? 7 : 1)),
    );

  const flash = (message: string) => {
    setNotice(message);
    setError('');
    window.setTimeout(() => setNotice((current) => (current === message ? '' : current)), 6000);
  };

  async function move(appointment: Appointment, column: GridColumn, startsAt: Date) {
    setError('');
    const sameTime = startsAt.getTime() === new Date(appointment.startsAt).getTime();
    const stylistChanged = column.stylistId && column.stylistId !== appointment.stylistId;
    if (sameTime && !stylistChanged) return;
    const result = await agendaSend(
      `/api/agenda/${appointment.id}?action=reschedule`,
      'PATCH',
      {
        startsAt: startsAt.toISOString(),
        ...(stylistChanged ? { stylistId: column.stylistId } : {}),
      },
      'No pudimos mover la cita.',
    );
    if (!result.ok) return setError(result.error);
    await queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
    flash(`Cita de ${appointment.clientName ?? 'la clienta'} movida a las ${time(startsAt)}.`);
  }

  const columnsFor = (day: Date, members: StylistShifts[]): GridColumn[] =>
    members.map((member) => ({
      key: `${member.stylistId}-${isoDay(day)}`,
      day,
      stylistId: member.stylistId,
      header: (
        <span className="flex flex-col items-center gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <span className="size-2.5 rounded-full" style={{ background: member.color }} />
            <span className="truncate">{member.name}</span>
          </span>
          <span className="text-[11px] text-muted-foreground">
            {plural(
              appointments.filter(
                (item) =>
                  item.stylistId === member.stylistId &&
                  isActive(item.status) &&
                  sameDay(new Date(item.startsAt), day),
              ).length,
              'cita',
              'citas',
            )}
          </span>
        </span>
      ),
      working: workingOn(member, day),
      blocks: blocksOn(member, day),
      appointments: appointments.filter(
        (item) => item.stylistId === member.stylistId && sameDay(new Date(item.startsAt), day),
      ),
    }));

  const dayColumns = columnsFor(anchor, visibleTeam);
  const weekColumns: GridColumn[] = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(from, index);
    return {
      key: isoDay(day),
      day,
      stylistId: visibleTeam.length === 1 ? visibleTeam[0].stylistId : null,
      header: (
        <button
          type="button"
          onClick={() => {
            setAnchor(day);
            setView('day');
          }}
          className={cn(
            'w-full rounded-lg text-xs',
            sameDay(day, new Date()) ? 'font-bold text-primary' : 'text-muted-foreground',
          )}
        >
          <span className="block uppercase">
            {day.toLocaleDateString('es-GT', { weekday: 'short' })}
          </span>
          <span className="text-lg text-foreground">{day.getDate()}</span>
        </button>
      ),
      working: mergeRanges(visibleTeam.flatMap((member) => workingOn(member, day))),
      blocks: visibleTeam.length === 1 ? blocksOn(visibleTeam[0], day) : [],
      appointments: appointments.filter((item) => sameDay(new Date(item.startsAt), day)),
    };
  });

  const gridColumns = view === 'week' ? weekColumns : dayColumns;
  const range = visibleHours(
    gridColumns.flatMap((column) => [
      ...column.working,
      ...column.appointments.map((item) => ({
        start: minutesInDay(item.startsAt, column.day),
        end: minutesInDay(item.endsAt, column.day),
      })),
    ]),
  );

  const dayAppointments = appointments.filter((item) => sameDay(new Date(item.startsAt), anchor));
  const summary = {
    total: dayAppointments.filter((item) => isActive(item.status) || item.status === 'COMPLETED')
      .length,
    confirmed: dayAppointments.filter((item) => item.status === 'CONFIRMED').length,
    toConfirm: dayAppointments.filter(
      (item) => item.status === 'SCHEDULED' && new Date(item.startsAt) > new Date(),
    ).length,
    revenue: dayAppointments
      .filter((item) => item.status !== 'CANCELLED' && item.status !== 'NO_SHOW')
      .reduce((sum, item) => sum + Number(item.estimatedTotal), 0),
  };

  const title =
    view === 'month'
      ? anchor.toLocaleDateString('es-GT', { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${from.getDate()} – ${addDays(from, 6).toLocaleDateString('es-GT', { day: 'numeric', month: 'long' })}`
        : sameDay(anchor, new Date())
          ? `Hoy, ${anchor.toLocaleDateString('es-GT', { day: 'numeric', month: 'long' })}`
          : dayLabel(anchor);

  const stylistNames = new Map(team.map((member) => [member.stylistId, member]));
  const ownStylistId = canBookOwn && !canBookAny ? (team[0]?.stylistId ?? null) : undefined;

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">
            {ownOnly ? 'Tu agenda' : 'Agenda del salón'}
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold first-letter:uppercase sm:text-4xl">
            {title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canApprove && (
            <Button variant="outline" onClick={() => setInbox(true)} className="relative">
              <CalendarClock size={18} />
              Cambios pedidos
              {(pending.data ?? 0) > 0 && (
                <span className="grid min-w-5 place-items-center rounded-full bg-warning px-1.5 text-[11px] font-bold text-white">
                  {pending.data}
                </span>
              )}
            </Button>
          )}
          {canUpdate && (
            <Button variant="outline" onClick={() => setReminders(true)} aria-label="Recordatorios">
              <BellRing size={18} />
              <span className="hidden sm:inline">Recordatorios</span>
            </Button>
          )}
          <NotificationsToggle />
          {(canBookAny || canBookOwn) && (
            <Button className="hidden lg:inline-flex" onClick={() => setBooking({ day: anchor })}>
              <Plus size={18} />
              Nueva cita
            </Button>
          )}
        </div>
      </header>

      <PendingRegisterBanner />

      {notice && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 size={16} className="shrink-0" />
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"
        >
          <TriangleAlert size={16} className="shrink-0" />
          {error}
        </p>
      )}
      {(calendar.error || shifts.error) && (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          No se pudo cargar la agenda completa.{' '}
          <button
            className="font-semibold underline"
            onClick={() => queryClient.invalidateQueries({ queryKey: AGENDA_KEY })}
          >
            Reintentar
          </button>
        </p>
      )}

      <Card className="overflow-hidden">
        {/* Navegación y vista. */}
        <div className="flex flex-wrap items-center gap-2 border-b p-2 sm:p-3">
          <div className="flex items-center">
            <button
              onClick={() => shift(-1)}
              aria-label="Anterior"
              className="grid size-11 place-items-center rounded-xl hover:bg-muted"
            >
              <ChevronLeft />
            </button>
            <button
              onClick={() => setAnchor(startOfDay(new Date()))}
              className="min-h-11 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-muted"
            >
              Hoy
            </button>
            <button
              onClick={() => shift(1)}
              aria-label="Siguiente"
              className="grid size-11 place-items-center rounded-xl hover:bg-muted"
            >
              <ChevronRight />
            </button>
            <label className="relative grid size-11 cursor-pointer place-items-center rounded-xl hover:bg-muted">
              <CalendarDays size={18} />
              <span className="sr-only">Ir a una fecha</span>
              <input
                type="date"
                value={isoDay(anchor)}
                onChange={(event) =>
                  event.target.value && setAnchor(parseIsoDay(event.target.value))
                }
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
          </div>
          <div role="tablist" aria-label="Vista" className="ml-auto flex rounded-xl bg-muted p-1">
            {VIEWS.map((item) => (
              <button
                key={item.value}
                role="tab"
                aria-selected={view === item.value}
                onClick={() => setView(item.value)}
                className={cn(
                  'min-h-9 rounded-lg px-3 text-sm font-semibold',
                  view === item.value ? 'bg-card shadow-sm' : 'text-muted-foreground',
                )}
              >
                {item.value === 'list' ? <List size={16} aria-label="Lista" /> : item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filtro por profesional: un toque oculta o muestra su columna. */}
        {team.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto border-b px-3 py-2">
            {team.map((member) => {
              const on = !hidden.has(member.stylistId);
              return (
                <button
                  key={member.stylistId}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setHidden((current) => {
                      const next = new Set(current);
                      if (next.has(member.stylistId)) next.delete(member.stylistId);
                      else next.add(member.stylistId);
                      return next;
                    })
                  }
                  className={cn(
                    'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm',
                    on ? 'bg-card font-medium' : 'bg-muted text-muted-foreground line-through',
                  )}
                >
                  <span className="size-2.5 rounded-full" style={{ background: member.color }} />
                  {member.name}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setShowCancelled((value) => !value)}
              aria-pressed={showCancelled}
              className="ml-auto inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:bg-muted"
            >
              {showCancelled ? <Eye size={14} /> : <EyeOff size={14} />}
              Canceladas
            </button>
          </div>
        )}

        {(view === 'day' || view === 'list') && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2 text-xs text-muted-foreground">
            <span>
              <strong className="text-foreground">{summary.total}</strong> citas
            </span>
            <span>
              <strong className="text-success">{summary.confirmed}</strong> confirmadas
            </span>
            {summary.toConfirm > 0 && (
              <span>
                <strong className="text-warning">{summary.toConfirm}</strong> sin confirmar
              </span>
            )}
            {!ownOnly && <span>Previsto {money(summary.revenue)}</span>}
          </div>
        )}

        {calendar.isPending || shifts.isPending ? (
          <div className="space-y-2 p-4" aria-busy="true">
            <p role="status" className="sr-only">
              Cargando agenda…
            </p>
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : view === 'month' ? (
          <MonthGrid
            from={from}
            month={anchor.getMonth()}
            appointments={appointments}
            onPick={(day) => {
              setAnchor(day);
              setView('day');
            }}
          />
        ) : view === 'list' ? (
          <DayList appointments={dayAppointments} onSelect={(item) => setSelectedId(item.id)} />
        ) : gridColumns.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No hay profesionales para mostrar. Activa alguna en el filtro.
          </p>
        ) : (
          <TimeGrid
            columns={gridColumns}
            range={range}
            canDrag={canUpdate}
            minColumnWidth={view === 'week' ? 110 : 150}
            onSelect={(item) => setSelectedId(item.id)}
            onMove={canUpdate ? move : undefined}
            onEmpty={
              canBookAny || canBookOwn || canManageSchedule
                ? (column, startsAt) => {
                    if (canManageSchedule && column.stylistId) setChoice({ column, startsAt });
                    else if (canBookAny || canBookOwn)
                      setBooking({
                        day: startsAt,
                        stylistId: column.stylistId ?? undefined,
                        startsAt: startsAt.toISOString(),
                      });
                  }
                : undefined
            }
            onBlock={(item) => {
              const source = team
                .find((member) => member.stylistId === item.stylistId)
                ?.blocks.find((candidate) => candidate.id === item.id);
              if (source)
                setBlock({
                  id: source.id,
                  stylistId: item.stylistId,
                  startsAt: new Date(source.startsAt),
                  endsAt: new Date(source.endsAt),
                  reason: source.reason,
                });
            }}
          />
        )}
      </Card>

      {(view === 'day' || view === 'week') && (
        <p className="hidden text-xs text-muted-foreground lg:block">
          Toca un hueco para agendar.{' '}
          {canUpdate && 'Arrastra una cita para moverla de hora o de profesional.'}
        </p>
      )}

      {/* Botón flotante en el móvil, al alcance del pulgar. */}
      {(canBookAny || canBookOwn) && (
        <button
          type="button"
          onClick={() => setBooking({ day: anchor })}
          aria-label="Nueva cita"
          className="fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg lg:hidden"
        >
          <Plus size={26} />
        </button>
      )}

      {booking && (
        <BookingWizard
          initialClientId={booking.clientId}
          initial={booking}
          team={team}
          services={services.data ?? []}
          ownStylistId={ownStylistId}
          onClose={() => setBooking(null)}
          onSaved={async (appointment) => {
            setBooking(null);
            setAnchor(startOfDay(new Date(appointment.startsAt)));
            await queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
            flash(
              `Cita reservada: ${appointment.clientName ?? 'clienta'} el ${dayLabel(new Date(appointment.startsAt), { weekday: 'long', month: 'short' })} a las ${time(appointment.startsAt)}`,
            );
          }}
        />
      )}

      {choice && (
        <SlotChoice
          stylist={{
            id: choice.column.stylistId!,
            name: stylistNames.get(choice.column.stylistId!)?.name ?? 'Profesional',
            color: stylistNames.get(choice.column.stylistId!)?.color ?? 'var(--primary)',
          }}
          startsAt={choice.startsAt}
          onClose={() => setChoice(null)}
          onBook={() => {
            setBooking({
              day: choice.startsAt,
              stylistId: choice.column.stylistId ?? undefined,
              startsAt: choice.startsAt.toISOString(),
            });
            setChoice(null);
          }}
          onDone={(message) => {
            setChoice(null);
            flash(message);
          }}
        />
      )}

      {block && (
        <BlockDetail
          block={block}
          stylistName={stylistNames.get(block.stylistId)?.name ?? 'la profesional'}
          canRemove={canManageSchedule}
          onClose={() => setBlock(null)}
          onDone={(message) => {
            setBlock(null);
            flash(message);
          }}
        />
      )}

      {selected && (
        <AppointmentSheet
          key={selected.id + selected.status + selected.startsAt}
          appointment={selected}
          team={team}
          onClose={() => setSelectedId(null)}
          onRegister={() => {
            setRegistering(selected);
            setSelectedId(null);
          }}
          onDone={(message) => {
            setSelectedId(null);
            flash(message);
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
                  name: stylistNames.get(registering.stylistId)?.name ?? 'la profesional',
                }
              : undefined
          }
          onClose={() => setRegistering(null)}
          onDone={async (ticket) => {
            setRegistering(null);
            flash(`Enviado a caja: ${ticket.clientName}. La cita queda completada.`);
            await Promise.all(
              [AGENDA_KEY, ['agenda-tickets'], MY_DAY_KEY, ['service-tickets-pending-count']].map(
                (queryKey) => queryClient.invalidateQueries({ queryKey }),
              ),
            );
          }}
        />
      )}

      {inbox && (
        <Sheet
          title="Cambios pedidos"
          description="Aprobar mueve la cita al momento."
          onClose={() => setInbox(false)}
        >
          <div className="-mx-5 -my-4">
            <ChangeRequestsInbox
              onDone={(message) => {
                flash(message);
                void queryClient.invalidateQueries({ queryKey: PENDING_CHANGES_KEY });
              }}
            />
          </div>
        </Sheet>
      )}

      {reminders && <RemindersSheet onClose={() => setReminders(false)} onDone={flash} />}
    </div>
  );
}

/** Tramos de jornada de una profesional un día, en minutos desde medianoche. */
function workingOn(member: StylistShifts, day: Date) {
  const entry = member.days.find((item) => item.date === isoDay(day));
  return (entry?.intervals ?? []).map((interval) => ({
    start: minutesInDay(interval.startsAt, day),
    end: minutesInDay(interval.endsAt, day),
  }));
}

function blocksOn(member: StylistShifts, day: Date) {
  return member.blocks
    .filter((block) => {
      const start = minutesInDay(block.startsAt, day);
      const end = minutesInDay(block.endsAt, day);
      return end > 0 && start < 24 * 60;
    })
    .map((block) => ({
      id: block.id,
      stylistId: member.stylistId,
      start: Math.max(0, minutesInDay(block.startsAt, day)),
      end: Math.min(24 * 60, minutesInDay(block.endsAt, day)),
      reason: block.reason,
    }));
}

/** Une tramos que se solapan: la jornada del salón un día es la de todo su equipo. */
function mergeRanges(ranges: { start: number; end: number }[]) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function MonthGrid({
  from,
  month,
  appointments,
  onPick,
}: {
  from: Date;
  month: number;
  appointments: Appointment[];
  onPick: (day: Date) => void;
}) {
  const today = new Date();
  return (
    <div className="grid grid-cols-7">
      {['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'].map((label) => (
        <div
          key={label}
          className="border-b p-2 text-center text-xs text-muted-foreground uppercase"
        >
          {label}
        </div>
      ))}
      {Array.from({ length: 42 }, (_, index) => {
        const day = addDays(from, index);
        const items = appointments.filter(
          (item) => sameDay(new Date(item.startsAt), day) && item.status !== 'CANCELLED',
        );
        return (
          <button
            key={isoDay(day)}
            type="button"
            onClick={() => onPick(day)}
            aria-label={`${dayLabel(day)}: ${items.length} citas`}
            className={cn(
              'flex min-h-20 flex-col items-stretch gap-1 border-r border-b p-1.5 text-left hover:bg-muted sm:min-h-28',
              day.getMonth() !== month && 'bg-muted/40 text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'grid size-7 place-items-center rounded-full text-sm',
                sameDay(day, today) && 'bg-primary font-bold text-primary-foreground',
              )}
            >
              {day.getDate()}
            </span>
            {/* En el móvil, puntos de color; en pantalla grande, las primeras citas. */}
            <span className="flex flex-wrap gap-0.5 sm:hidden">
              {items.slice(0, 6).map((item) => (
                <span
                  key={item.id}
                  className="size-1.5 rounded-full"
                  style={{ background: item.stylistColor ?? 'var(--primary)' }}
                />
              ))}
            </span>
            <span className="hidden space-y-0.5 sm:block">
              {items.slice(0, 3).map((item) => (
                <span
                  key={item.id}
                  className="block truncate rounded border-l-2 bg-muted px-1 text-[11px]"
                  style={{ borderLeftColor: item.stylistColor ?? 'var(--primary)' }}
                >
                  {time(item.startsAt)} {item.clientName}
                </span>
              ))}
              {items.length > 3 && (
                <span className="block text-[11px] text-muted-foreground">
                  +{items.length - 3} más
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** El día como lista: lo más cómodo en un teléfono para repasar quién viene. */
function DayList({
  appointments,
  onSelect,
}: {
  appointments: Appointment[];
  onSelect: (appointment: Appointment) => void;
}) {
  const sorted = [...appointments].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  if (!sorted.length) {
    return <p className="p-8 text-center text-sm text-muted-foreground">No hay citas este día.</p>;
  }
  return (
    <ul className="divide-y">
      {sorted.map((item) => {
        const meta = statusMeta(item.status);
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item)}
              className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted sm:p-4"
            >
              <span
                className="h-12 w-1.5 shrink-0 rounded-full"
                style={{ background: item.stylistColor ?? 'var(--primary)' }}
              />
              <span className="w-[4.75rem] shrink-0 text-sm font-bold whitespace-nowrap tabular-nums">
                {time(item.startsAt)}
                <span className="block text-xs font-normal text-muted-foreground">
                  {item.durationMinutes} min
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate font-semibold', meta.block)}>
                  {item.clientName ?? 'Clienta'}
                </span>
                <span className="block truncate text-sm text-muted-foreground">
                  {item.stylistName} ·{' '}
                  {item.services
                    .map((line) => line.name)
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', meta.badge)}
                >
                  {meta.label}
                </span>
                {item.pendingChange && (
                  <CalendarClock size={14} className="text-warning" aria-label="Cambio pedido" />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Pedir permiso para avisos del sistema. Nunca se pide solo: es un botón que se pulsa. */
function NotificationsToggle() {
  const [state, setState] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  if (state !== 'default') return null;
  return (
    <Button
      variant="ghost"
      onClick={async () => setState(await Notification.requestPermission())}
      title="Recibir un aviso cuando alguien pide un cambio o agenda"
    >
      <Bell size={18} />
      <span className="hidden sm:inline">Activar avisos</span>
    </Button>
  );
}

function RemindersSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = useQuery({
    queryKey: ['agenda-reminder-settings'],
    queryFn: () =>
      agendaGet<{ enabled: boolean; channel: string; leadHours: number }>('reminder-settings'),
  });

  async function run() {
    setBusy(true);
    setError('');
    const result = await agendaSend<{ sent: number; failed: number; skipped: number }>(
      '/api/agenda/reminders/run',
      'POST',
    );
    setBusy(false);
    if (!result.ok) return setError(result.error);
    await queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
    const { sent, failed, skipped } = result.data;
    onClose();
    onDone(
      sent + failed + skipped === 0
        ? 'No había recordatorios pendientes.'
        : `Recordatorios: ${sent} enviados${failed ? `, ${failed} fallidos` : ''}${skipped ? `, ${skipped} sin teléfono` : ''}.`,
    );
  }

  const channel = settings.data?.channel;
  return (
    <Sheet title="Recordatorios" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p>
          Cada clienta recibe un mensaje{' '}
          <strong>{settings.data?.leadHours ?? 24} horas antes</strong> de su cita con un enlace
          para confirmarla o cancelarla. Si cancela, el hueco aparece libre en la agenda al momento.
        </p>
        {channel === 'LOG' && (
          <p className="rounded-xl bg-warning/15 p-3 text-warning">
            Todavía no hay proveedor de WhatsApp contratado: los envíos automáticos se registran
            pero no salen. Mientras tanto, abre la cita y usa «Recordar por WhatsApp» para mandarlo
            desde el teléfono del salón.
          </p>
        )}
        {settings.data && !settings.data.enabled && (
          <p className="rounded-xl bg-muted p-3">Los envíos automáticos están desactivados.</p>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={run}>
          <Send size={16} />
          {busy ? 'Enviando…' : 'Enviar ahora los pendientes'}
        </Button>
      </div>
    </Sheet>
  );
}
