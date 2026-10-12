'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
import { useEffect, useState, type FormEvent } from 'react';
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
  QUEUE_KEY,
  QUEUE_STATUS_LABEL,
  queueAction,
  waitedLabel,
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
  const [freeStylist, setFreeStylist] = useState('');
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
  const free = team.filter((stylist) => !busyIds.has(stylist.id));

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

  async function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!freeStylist) return;
    const name =
      team.find((stylist) => stylist.id === freeStylist)?.displayName ?? 'La profesional';
    const outcome = await run(() => callNext(freeStylist));
    if (outcome.ok) {
      const turn = (outcome.data as { turn: QueueTurn | null }).turn;
      if (turn) setNotice(`Turno ${turn.number}: ${turn.clientName} pasa con ${name}.`);
      else setError(`No queda nadie en la fila que ${name} pueda atender.`);
    }
    setFreeStylist('');
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

      {canAttend && waiting.length > 0 && (
        <Card className="p-4">
          <form onSubmit={next} className="flex flex-wrap items-center gap-2">
            <BellRing size={18} className="text-primary" />
            <label htmlFor="free-stylist" className="text-sm font-semibold">
              Quedó libre
            </label>
            <select
              id="free-stylist"
              value={freeStylist}
              onChange={(event) => setFreeStylist(event.target.value)}
              className="h-11 min-w-0 flex-1 basis-40 rounded-xl border bg-background px-3 text-sm"
            >
              <option value="">Elige la profesional…</option>
              {free.map((stylist) => (
                <option key={stylist.id} value={stylist.id}>
                  {stylist.displayName}
                </option>
              ))}
            </select>
            <Button className="w-full sm:w-auto" disabled={busy || !freeStylist}>
              Llamar a la siguiente
            </Button>
          </form>
        </Card>
      )}

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
          <QueueTicket turn={printing} salonName={salonName} />
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
            {' · '}
            {waitedLabel(turn.createdAt, now)}
          </p>
          {turn.notes && <p className="text-sm text-muted-foreground italic">{turn.notes}</p>}
        </div>
        {canAttend && (
          <select
            aria-label={`Llamar a ${turn.clientName} con`}
            value=""
            disabled={busy || team.length === 0}
            onChange={(event) => event.target.value && onCall(event.target.value)}
            className="h-11 rounded-xl border bg-background px-3 text-sm"
          >
            <option value="">{team.length ? 'Llamar con…' : 'Nadie libre que lo haga'}</option>
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
