'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Megaphone, Scissors, Undo2, UserCheck, UserX, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RegisterServiceDialog } from '@/features/service-tickets/register-service-dialog';
import type { ServiceTicket } from '@/features/service-tickets/types';
import {
  callNext,
  fetchQueue,
  isActive,
  minutesLabel,
  minutesSince,
  QUEUE_KEY,
  queueAction,
  waitedLabel,
  type QueueAction,
  type QueueTurn,
} from './types';

/**
 * La fila de espera vista por la profesional, en «Mi día» (ADR-0024).
 *
 * Una sola pregunta: ¿a quién atiendo ahora? Si está libre, cuántas la esperan y un botón
 * para llamar a la siguiente; si ya llamó, lo que puede pasar —ya está conmigo, no vino—; y
 * al terminar, lo de siempre: «¿qué le hiciste?», que envía la comanda a caja.
 */
export function MyQueueCard({
  stylistId,
  onFinished,
}: {
  stylistId: string;
  onFinished: (ticket: ServiceTicket) => void;
}) {
  const qc = useQueryClient();
  const { can } = useAccess();
  const canSee = can('queue.read.own') || can('queue.read');
  const canAttend = can('queue.attend.own') || can('queue.attend');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState<QueueTurn | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const queue = useQuery({
    queryKey: [...QUEUE_KEY, 'board'],
    enabled: canSee && canAttend,
    // Red de seguridad del canal en vivo, que es quien la refresca al instante.
    refetchInterval: 30_000,
    queryFn: fetchQueue,
  });

  if (!canSee || !canAttend) return null;

  const turns = queue.data?.turns ?? [];
  const mine = turns.find((turn) => turn.stylistId === stylistId && isActive(turn));
  // Con `queue.read.own` la API ya filtra; quien atiende y además ve toda la fila (la
  // propietaria que también corta) no cuenta a las que pidieron a otra profesional.
  const waiting = turns.filter(
    (turn) =>
      turn.status === 'WAITING' &&
      (!turn.preferredStylistId || turn.preferredStylistId === stylistId),
  );

  const refresh = () => qc.invalidateQueries({ queryKey: QUEUE_KEY });

  async function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError('');
    const outcome = await work();
    setBusy(false);
    if (!outcome.ok) setError(outcome.error ?? 'No pudimos guardar el cambio.');
    await refresh();
  }

  const act = (action: QueueAction) => () => run(() => queueAction(mine!.id, action));

  async function next() {
    await run(async () => {
      const outcome = await callNext();
      if (outcome.ok && !outcome.data.turn) {
        return { ok: false, error: 'Ya no queda nadie en la fila que puedas atender.' };
      }
      return outcome;
    });
  }

  const alert = error && (
    <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
      {error}
    </p>
  );

  if (mine) {
    const called = mine.status === 'CALLED';
    return (
      <Card className={`border-2 p-5 ${called ? 'border-warning' : 'border-primary'}`}>
        <p
          className={`flex items-center gap-2 text-xs font-bold tracking-wide uppercase ${called ? 'text-warning' : 'text-primary'}`}
        >
          {called ? <BellRing size={14} /> : <Scissors size={14} />}
          {called ? `Llamaste al turno ${mine.number}` : `Turno ${mine.number} · atendiendo`}
        </p>
        <p className="mt-2 font-display text-2xl font-semibold">{mine.clientName}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {mine.serviceNames.join(' · ') || 'Sin servicio anotado'}
          {mine.notes && ` · ${mine.notes}`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {called
            ? `Esperó ${minutesLabel(minutesSince(mine.createdAt, new Date(mine.firstCalledAt ?? now)))} · la llamaste hace ${minutesLabel(minutesSince(mine.calledAt ?? now.toISOString(), now))}`
            : `En el sillón desde hace ${minutesLabel(minutesSince(mine.startedAt ?? now.toISOString(), now))}`}
        </p>
        {alert && <div className="mt-3">{alert}</div>}
        {called && (
          <>
            <Button disabled={busy} className="mt-4 h-14 w-full text-base" onClick={act('start')}>
              <UserCheck size={18} />
              Ya está conmigo
            </Button>
            <div className="mt-2 flex flex-wrap justify-center gap-1">
              <Button disabled={busy} variant="ghost" onClick={act('recall')}>
                <Megaphone size={16} />
                Volver a llamar
              </Button>
              <Button disabled={busy} variant="ghost" onClick={act('no-show')}>
                <UserX size={16} />
                No vino
              </Button>
              <Button disabled={busy} variant="ghost" onClick={act('requeue')}>
                <Undo2 size={16} />A la fila
              </Button>
            </div>
          </>
        )}
        <Button
          variant={called ? 'outline' : 'primary'}
          className="mt-3 h-14 w-full text-base"
          disabled={busy}
          onClick={() => setFinishing(mine)}
        >
          Registrar lo que le hice
        </Button>
        {finishing && (
          <RegisterServiceDialog
            turn={finishing}
            onClose={() => setFinishing(null)}
            onDone={async (ticket) => {
              setFinishing(null);
              await refresh();
              onFinished(ticket);
            }}
          />
        )}
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-secondary-foreground">
          <Users size={20} />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <h2 className="font-display text-lg font-semibold">Fila de espera</h2>
          <p className="text-sm text-muted-foreground">
            {queue.isPending
              ? 'Cargando…'
              : waiting.length === 0
                ? 'Nadie te espera ahora mismo.'
                : waiting.length === 1
                  ? 'Una clienta que puedes atender.'
                  : `${waiting.length} clientas que puedes atender.`}
          </p>
        </div>
        <Button
          className="h-12 w-full sm:w-auto"
          disabled={busy || waiting.length === 0}
          onClick={next}
        >
          <BellRing size={18} />
          Llamar siguiente
        </Button>
      </div>
      {waiting.length > 0 && (
        <ul className="mt-3 divide-y rounded-xl border">
          {waiting.slice(0, 3).map((turn) => (
            <li key={turn.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="w-10 shrink-0 font-bold tabular-nums">#{turn.number}</span>
              <span className="min-w-0 flex-1 truncate">
                {turn.clientName}
                <span className="text-muted-foreground">
                  {' · '}
                  {turn.serviceNames.join(', ') || 'por decidir'}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {waitedLabel(turn.createdAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {alert && <div className="mt-3">{alert}</div>}
      {queue.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {queue.error.message}
        </p>
      )}
    </Card>
  );
}
