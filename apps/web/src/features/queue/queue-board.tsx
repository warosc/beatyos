'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  BellRing,
  CheckCircle2,
  Megaphone,
  Printer,
  Scissors,
  Tv,
  Undo2,
  UserCheck,
  UserPlus,
  UserX,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { EmptyState, LoadError } from '@/components/ui/states';
import { useServiceCatalog } from '@/features/agenda/use-agenda';
import { canPerform, type PosStylist } from '@/features/sales/stylist-select';
import { fetchTenantProfile, TENANT_PROFILE_KEY } from '@/features/sales/types';
import { RegisterServiceDialog } from '@/features/service-tickets/register-service-dialog';
import { loadOptions } from '@/lib/pagination';
import { cn, money } from '@/lib/utils';
import { DisplayLinkDialog } from './display-link-dialog';
import { QueueTicket } from './queue-ticket';
import {
  callNext,
  callTurn,
  fetchQueue,
  isActive,
  MIN_WAIT_SAMPLES,
  minutesLabel,
  minutesSince,
  QUEUE_KEY,
  QUEUE_STATUS_LABEL,
  queueAction,
  waitedLabel,
  waitTone,
  type QueueAction,
  type QueueTurn,
} from './types';
import { WalkInDialog } from './walk-in-dialog';

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * Fila de espera del mostrador (ADR-0024).
 *
 * Recepción anota a quien llega sin cita, ve quién espera y cuánto, y a quién se llamó y con
 * quién. Puede llamar por una profesional que no tiene el móvil a mano, asignar a otra a una
 * clienta que cambia de idea y cerrar el turno enviando la comanda a caja.
 */
export function QueueBoard() {
  const qc = useQueryClient();
  const { can } = useAccess();
  const canAttend = can('queue.attend');
  const [now, setNow] = useState(() => new Date());
  const [adding, setAdding] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [printing, setPrinting] = useState<QueueTurn | null>(null);
  const [finishing, setFinishing] = useState<QueueTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const queue = useQuery({
    queryKey: [...QUEUE_KEY, 'board'],
    refetchInterval: 30_000,
    queryFn: fetchQueue,
  });
  const services = useServiceCatalog(can('queue.create'));
  const stylists = useQuery({
    queryKey: ['stylists', 'active'],
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      loadOptions<PosStylist>('/api/agenda?resource=stylists&status=ACTIVE&sort=name:asc', signal),
  });
  const salon = useQuery({
    queryKey: TENANT_PROFILE_KEY,
    staleTime: 10 * 60_000,
    queryFn: fetchTenantProfile,
  });
  const salonName = salon.data?.name ?? 'Salón';

  const turns = queue.data?.turns ?? [];
  const active = turns.filter(isActive);
  const waiting = turns.filter((turn) => turn.status === 'WAITING');
  const closed = turns.filter((turn) => !isActive(turn) && turn.status !== 'WAITING');
  const team = stylists.data ?? [];
  const busyIds = new Set(active.map((turn) => turn.stylistId));
  // La espera aproximada solo se dice con varias llamadas de hoy detrás.
  const estimatedWait =
    queue.data && queue.data.waitSamples >= MIN_WAIT_SAMPLES ? queue.data.averageWaitMinutes : null;

  const refresh = () => qc.invalidateQueries({ queryKey: QUEUE_KEY });

  async function run(
    work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>,
    success?: string,
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    const outcome = await work();
    setBusy(false);
    if (!outcome.ok) setError(outcome.error);
    else if (success) setNotice(success);
    await refresh();
    return outcome;
  }

  async function nextFor(stylist: PosStylist) {
    const outcome = await run(() => callNext(stylist.id));
    if (outcome.ok) {
      const turn = (outcome.data as { turn: QueueTurn | null }).turn;
      if (turn)
        setNotice(`Turno ${turn.number}: ${turn.clientName} pasa con ${stylist.displayName}.`);
      else setError(`No queda nadie en la fila que ${stylist.displayName} pueda atender.`);
    }
  }

  if (queue.error) {
    return <LoadError message={queue.error.message} onRetry={() => void queue.refetch()} />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-primary first-letter:uppercase">
            {now.toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="mt-1 font-display text-4xl font-semibold">Fila de espera</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {waiting.length === 0
              ? 'Nadie espera ahora mismo.'
              : `${waiting.length} ${waiting.length === 1 ? 'clienta espera' : 'clientas esperan'}`}
            {active.length > 0 && ` · ${active.length} en atención`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('reports.read') && (
            <Link
              href="/turnos/estadisticas"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border bg-card px-4 text-sm font-semibold hover:bg-muted"
            >
              <BarChart3 size={18} />
              Estadísticas
            </Link>
          )}
          {can('queue.manage-display') && (
            <Button variant="outline" onClick={() => setShowLink(true)}>
              <Tv size={18} />
              Pantalla de la TV
            </Button>
          )}
          {can('queue.create') && (
            <Button className="h-12" onClick={() => setAdding(true)}>
              <UserPlus size={18} />
              Anotar clienta
            </Button>
          )}
        </div>
      </header>

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
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      <TodaySummary
        waiting={waiting}
        turns={turns.filter((turn) => turn.businessDate === queue.data?.businessDate)}
        averageWait={queue.data?.averageWaitMinutes ?? null}
        now={now}
      />

      <TeamPanel
        team={team}
        active={active}
        waiting={waiting}
        now={now}
        busy={busy}
        canAttend={canAttend}
        onCallNext={(stylist) => void nextFor(stylist)}
      />

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">Llamadas y en el sillón</h2>
        {active.length === 0 ? (
          <EmptyState title="Nadie en atención" hint="Las que se llamen aparecerán aquí." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {active.map((turn) => (
              <ActiveTurn
                key={turn.id}
                turn={turn}
                busy={busy}
                canAttend={canAttend}
                onAction={(action) => run(() => queueAction(turn.id, action))}
                onFinish={() => setFinishing(turn)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl font-semibold">
          En espera <span className="text-muted-foreground">({waiting.length})</span>
        </h2>
        {queue.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cargando la fila…
          </p>
        ) : waiting.length === 0 ? (
          <EmptyState
            title="La fila está vacía"
            hint={can('queue.create') ? 'Anota a quien llegue sin cita.' : undefined}
          />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y">
              {waiting.map((turn) => (
                <WaitingTurn
                  key={turn.id}
                  turn={turn}
                  now={now}
                  busy={busy}
                  canAttend={canAttend}
                  team={team.filter(
                    (stylist) =>
                      !busyIds.has(stylist.id) &&
                      turn.serviceIds.every((serviceId) => canPerform(stylist, serviceId)),
                  )}
                  onCall={(stylistId) =>
                    run(
                      () => callTurn(turn.id, stylistId),
                      `Turno ${turn.number} llamado: ${turn.clientName}.`,
                    )
                  }
                  onCancel={(reason) =>
                    run(() => queueAction(turn.id, 'cancel', reason ? { reason } : {}))
                  }
                  onPrint={() => setPrinting(turn)}
                />
              ))}
            </ul>
          </Card>
        )}
      </section>

      {closed.length > 0 && (
        <details className="rounded-2xl border bg-card">
          <summary className="cursor-pointer p-4 font-display text-lg font-semibold">
            Hoy ya salieron de la fila ({closed.length})
          </summary>
          <ul className="divide-y border-t">
            {closed.map((turn) => (
              <li key={turn.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="w-10 font-bold tabular-nums">#{turn.number}</span>
                <span className="min-w-0 flex-1">
                  {turn.clientName}
                  {turn.stylistName && (
                    <span className="text-muted-foreground"> · con {turn.stylistName}</span>
                  )}
                  {turn.cancellationReason && (
                    <span className="text-muted-foreground"> · {turn.cancellationReason}</span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{time(turn.closedAt)}</span>
                <StatusBadge turn={turn} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {adding && (
        <WalkInDialog
          services={services.data ?? []}
          stylists={team}
          salonName={salonName}
          estimatedWait={estimatedWait}
          onClose={() => setAdding(false)}
          onSaved={() => void refresh()}
        />
      )}
      {showLink && <DisplayLinkDialog onClose={() => setShowLink(false)} />}
      {printing && (
        <Sheet
          title={`Ticket del turno ${printing.number}`}
          onClose={() => setPrinting(null)}
          footer={
            <Button className="w-full" onClick={() => window.print()}>
              <Printer size={18} />
              Imprimir
            </Button>
          }
        >
          <QueueTicket turn={printing} salonName={salonName} estimatedWait={estimatedWait} />
        </Sheet>
      )}
      {finishing && finishing.stylistId && (
        <RegisterServiceDialog
          turn={finishing}
          onBehalfOf={{
            stylistId: finishing.stylistId,
            name: finishing.stylistName ?? 'Profesional',
          }}
          onClose={() => setFinishing(null)}
          onDone={async (ticket) => {
            setFinishing(null);
            setNotice(`Enviado a caja: ${ticket.clientName} · ${money(ticket.total)}`);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** Lo de hoy de un vistazo: lo que recepción mira antes de decir «hay unos 20 minutos». */
function TodaySummary({
  waiting,
  turns,
  averageWait,
  now,
}: {
  waiting: readonly QueueTurn[];
  turns: readonly QueueTurn[];
  averageWait: number | null;
  now: Date;
}) {
  const longest = Math.max(0, ...waiting.map((turn) => minutesSince(turn.createdAt, now)));
  const tone = waiting.length ? waitTone(longest) : 'calm';
  const attended = turns.filter((turn) => turn.status === 'DONE').length;
  const lost = turns.filter(
    (turn) => turn.status === 'CANCELLED' || turn.status === 'NO_SHOW',
  ).length;
  const tiles: { label: string; value: string; className?: string; icon?: ReactNode }[] = [
    { label: 'Esperan ahora', value: String(waiting.length) },
    {
      label: 'Espera más larga',
      value: waiting.length ? minutesLabel(longest) : '—',
      className: tone === 'late' ? 'text-danger' : tone === 'attention' ? 'text-warning' : '',
      icon: tone === 'calm' ? undefined : <AlertTriangle size={16} aria-label="Espera larga" />,
    },
    { label: 'Espera media hoy', value: averageWait === null ? '—' : minutesLabel(averageWait) },
    { label: 'Atendidas hoy', value: String(attended) },
    { label: 'Se perdieron hoy', value: String(lost) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {tiles.map((tile, index) => (
        <div
          key={tile.label}
          className={cn(
            'rounded-2xl border bg-card p-4',
            // Cinco en dos columnas dejarían una sola: la primera ocupa la fila entera.
            index === 0 && 'col-span-2 sm:col-span-1',
          )}
        >
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd className={cn('mt-1 flex items-center gap-1.5 text-2xl font-bold', tile.className)}>
            {tile.icon}
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * El equipo de un vistazo: quién está libre y a cuántas de la fila puede atender, y quién
 * está ocupada, con quién y desde cuándo. Llamar por una profesional libre es un toque.
 */
function TeamPanel({
  team,
  active,
  waiting,
  now,
  busy,
  canAttend,
  onCallNext,
}: {
  team: readonly PosStylist[];
  active: readonly QueueTurn[];
  waiting: readonly QueueTurn[];
  now: Date;
  busy: boolean;
  canAttend: boolean;
  onCallNext: (stylist: PosStylist) => void;
}) {
  if (!team.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-semibold">Equipo</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {team.map((stylist) => {
          const turn = active.find((candidate) => candidate.stylistId === stylist.id);
          const attendable = waiting.filter(
            (candidate) =>
              (!candidate.preferredStylistId || candidate.preferredStylistId === stylist.id) &&
              candidate.serviceIds.every((serviceId) => canPerform(stylist, serviceId)),
          ).length;
          return (
            <li
              key={stylist.id}
              className={cn(
                'flex items-center gap-3 rounded-2xl border bg-card p-3',
                turn && 'bg-muted/60',
              )}
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: stylist.color ?? 'var(--primary-ink)' }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{stylist.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {turn
                    ? `${turn.status === 'CALLED' ? 'Llamó a' : 'Con'} ${turn.clientName} · ${minutesLabel(
                        minutesSince(
                          (turn.status === 'CALLED' ? turn.calledAt : turn.startedAt) ??
                            turn.createdAt,
                          now,
                        ),
                      )}`
                    : attendable
                      ? `Libre · puede atender a ${attendable}`
                      : 'Libre'}
                </p>
              </div>
              {!turn && canAttend && (
                <Button
                  variant="outline"
                  className="min-h-10 px-3"
                  disabled={busy || attendable === 0}
                  onClick={() => onCallNext(stylist)}
                >
                  <BellRing size={16} />
                  Siguiente
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusBadge({ turn }: { turn: QueueTurn }) {
  const tone =
    turn.status === 'DONE'
      ? 'bg-success/10 text-success'
      : turn.status === 'CALLED'
        ? 'bg-warning/15 text-warning'
        : turn.status === 'IN_SERVICE'
          ? 'bg-primary/10 text-primary'
          : 'bg-muted text-muted-foreground';
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', tone)}>
      {QUEUE_STATUS_LABEL[turn.status]}
    </span>
  );
}

function ActiveTurn({
  turn,
  busy,
  canAttend,
  onAction,
  onFinish,
}: {
  turn: QueueTurn;
  busy: boolean;
  canAttend: boolean;
  onAction: (action: QueueAction) => void;
  onFinish: () => void;
}) {
  const called = turn.status === 'CALLED';
  return (
    <Card className={cn('border-2 p-4', called ? 'border-warning/70' : 'border-primary/50')}>
      <div className="flex items-start gap-3">
        <span className="text-3xl font-bold tabular-nums">{turn.number}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{turn.clientName}</p>
          <p className="text-sm text-muted-foreground">
            con {turn.stylistName ?? 'Profesional'} ·{' '}
            {called
              ? `llamada ${time(turn.calledAt)}${turn.callCount > 1 ? ` (${turn.callCount} veces)` : ''}`
              : `desde ${time(turn.startedAt)}`}
          </p>
          {turn.serviceNames.length > 0 && (
            <p className="truncate text-sm text-muted-foreground">
              {turn.serviceNames.join(' · ')}
            </p>
          )}
        </div>
        <StatusBadge turn={turn} />
      </div>
      {canAttend && (
        <div className="mt-3 flex flex-wrap gap-2">
          {called && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onAction('start')}>
                <UserCheck size={16} />
                En el sillón
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => onAction('recall')}>
                <Megaphone size={16} />
                Volver a llamar
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => onAction('no-show')}>
                <UserX size={16} />
                No vino
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => onAction('requeue')}>
                <Undo2 size={16} />A la fila
              </Button>
            </>
          )}
          <Button disabled={busy} onClick={onFinish}>
            <Scissors size={16} />
            Terminar
          </Button>
        </div>
      )}
    </Card>
  );
}

function WaitingTurn({
  turn,
  now,
  busy,
  canAttend,
  team,
  onCall,
  onCancel,
  onPrint,
}: {
  turn: QueueTurn;
  now: Date;
  busy: boolean;
  canAttend: boolean;
  /** Libres y que saben hacer lo que pide. */
  team: readonly PosStylist[];
  onCall: (stylistId: string) => void;
  onCancel: (reason: string) => void;
  onPrint: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          aria-label={`Puesto ${turn.position}`}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-sm font-bold"
        >
          {turn.position}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-semibold">
            <span className="tabular-nums">#{turn.number}</span> · {turn.clientName}
          </p>
          <p className="text-sm text-muted-foreground">
            {turn.serviceNames.join(' · ') || 'Por decidir'}
            {turn.preferredStylistName && ` · pide a ${turn.preferredStylistName}`}
          </p>
          <WaitBadge since={turn.createdAt} now={now} />
          {turn.notes && <p className="text-sm text-muted-foreground italic">{turn.notes}</p>}
        </div>
        {canAttend && (
          <select
            aria-label={`Llamar a ${turn.clientName} con`}
            value=""
            disabled={busy || team.length === 0}
            onChange={(event) => event.target.value && onCall(event.target.value)}
            className="h-11 w-44 rounded-xl border bg-background px-3 text-sm"
          >
            <option value="">{team.length ? 'Llamar con…' : 'Nadie libre'}</option>
            {team.map((stylist) => (
              <option key={stylist.id} value={stylist.id}>
                {stylist.displayName}
                {turn.preferredStylistId && turn.preferredStylistId !== stylist.id
                  ? ' (no es quien pidió)'
                  : ''}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="ghost"
          aria-label={`Imprimir ticket del turno ${turn.number}`}
          onClick={onPrint}
        >
          <Printer size={16} />
        </Button>
        {canAttend && !cancelling && (
          <Button variant="ghost" disabled={busy} onClick={() => setCancelling(true)}>
            <XCircle size={16} />
            Se fue
          </Button>
        )}
      </div>
      {cancelling && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onCancel(reason.trim());
            setCancelling(false);
          }}
          className="mt-3 flex flex-wrap gap-2"
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={250}
            placeholder="Motivo (opcional)"
            aria-label="Motivo"
            className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm"
          />
          <Button variant="outline">Sacar de la fila</Button>
          <Button type="button" variant="ghost" onClick={() => setCancelling(false)}>
            Volver
          </Button>
        </form>
      )}
    </li>
  );
}

/**
 * Cuánto lleva esperando, con color a partir de los 15 minutos. El color acompaña al texto,
 * nunca lo sustituye: la cifra está siempre escrita.
 */
function WaitBadge({ since, now }: { since: string; now: Date }) {
  const tone = waitTone(minutesSince(since, now));
  return (
    <span
      className={cn(
        'mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'late'
          ? 'bg-danger/10 text-danger'
          : tone === 'attention'
            ? 'bg-warning/15 text-warning'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {tone !== 'calm' && <AlertTriangle size={12} aria-hidden />}
      {waitedLabel(since, now)}
    </span>
  );
}
