'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { agendaSend } from './api';
import { dayLabel, sameDay, time } from './time';
import type { ChangeRequest } from './types';
import { AGENDA_KEY, PENDING_CHANGES_KEY, useChangeRequests } from './use-agenda';

const STATUS_TEXT: Record<ChangeRequest['status'], { label: string; tone: string }> = {
  PENDING: { label: 'Esperando respuesta', tone: 'bg-warning/15 text-warning' },
  APPROVED: { label: 'Aprobado', tone: 'bg-success/15 text-success' },
  REJECTED: { label: 'No aprobado', tone: 'bg-danger/15 text-danger' },
  WITHDRAWN: { label: 'Retirado', tone: 'bg-muted text-muted-foreground' },
};

const when = (iso: string) => {
  const date = new Date(iso);
  return sameDay(date, new Date())
    ? `hoy ${time(iso)}`
    : `${dayLabel(date, { weekday: 'short', month: 'short' })} ${time(iso)}`;
};

/**
 * Bandeja de la encargada: lo que piden las profesionales, de lo más antiguo a lo más
 * reciente. Aprobar mueve la cita en el acto; si la hora ya no está libre, lo dice y la
 * petición sigue ahí para rechazarla con un motivo.
 */
export function ChangeRequestsInbox({ onDone }: { onDone: (message: string) => void }) {
  const requests = useChangeRequests('PENDING');
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function decide(request: ChangeRequest, action: 'approve' | 'reject') {
    setBusy(request.id);
    setErrors((current) => ({ ...current, [request.id]: '' }));
    const note = notes[request.id]?.trim();
    const result = await agendaSend(
      `/api/agenda/change-requests/${request.id}/${action}`,
      'PATCH',
      note ? { note } : {},
    );
    setBusy(null);
    if (!result.ok) {
      setErrors((current) => ({ ...current, [request.id]: result.error }));
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: AGENDA_KEY }),
      queryClient.invalidateQueries({ queryKey: PENDING_CHANGES_KEY }),
    ]);
    onDone(
      action === 'approve'
        ? `Aprobado: la cita de ${request.clientName ?? 'la clienta'} se movió.`
        : 'Cambio rechazado. La profesional verá el motivo.',
    );
  }

  if (requests.isPending) return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>;
  if (!requests.data?.length) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <CheckCircle2 size={16} className="text-success" />
        No hay cambios esperando respuesta.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {requests.data.map((request) => (
        <li key={request.id} className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <span
              className="mt-1 size-3 shrink-0 rounded-full"
              style={{ background: request.stylistColor ?? 'var(--primary)' }}
            />
            <div className="min-w-0 flex-1 text-sm">
              <p>
                <strong>{request.stylistName ?? 'Profesional'}</strong> pide mover la cita de{' '}
                <strong>{request.clientName ?? 'una clienta'}</strong>
                {request.serviceNames.length > 0 && (
                  <span className="text-muted-foreground">
                    {' '}
                    ({request.serviceNames.join(', ')})
                  </span>
                )}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 tabular-nums">
                <span className="text-muted-foreground line-through">
                  {when(request.currentStartsAt)}
                </span>
                <ArrowRight size={14} />
                <span className="font-semibold">
                  {when(request.proposedStartsAt)}
                </span>
                <span className="text-muted-foreground">· {request.durationMinutes} min</span>
              </p>
              {request.reason && <p className="mt-1 text-muted-foreground">«{request.reason}»</p>}
            </div>
          </div>
          <input
            value={notes[request.id] ?? ''}
            onChange={(event) =>
              setNotes((current) => ({ ...current, [request.id]: event.target.value }))
            }
            maxLength={500}
            placeholder="Nota para la profesional (opcional)"
            aria-label={`Nota para ${request.stylistName ?? 'la profesional'}`}
            className="h-11 w-full rounded-xl border bg-background px-3 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy === request.id} onClick={() => decide(request, 'approve')}>
              <CheckCircle2 size={17} />
              Aprobar y mover
            </Button>
            <Button
              variant="outline"
              disabled={busy === request.id}
              onClick={() => decide(request, 'reject')}
            >
              <XCircle size={17} />
              Rechazar
            </Button>
          </div>
          {errors[request.id] && (
            <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
              {errors[request.id]}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Lo que pidió la profesional y qué le contestaron. Va en «Mi día». */
export function MyChangeRequests() {
  const requests = useChangeRequests('ALL');
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [weekAgo] = useState(() => Date.now() - 7 * 86_400_000);
  // Las decididas hace más de una semana ya no aportan nada en el día a día.
  const recent = (requests.data ?? []).filter(
    (request) =>
      request.status === 'PENDING' ||
      new Date(request.decidedAt ?? request.requestedAt).getTime() > weekAgo,
  );
  if (!recent.length) return null;

  async function withdraw(id: string) {
    setBusy(id);
    await agendaSend(`/api/agenda/change-requests/${id}/withdraw`, 'PATCH', {});
    setBusy(null);
    await queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
  }

  return (
    <Card className="overflow-hidden">
      <h2 className="flex items-center gap-2 border-b p-4 font-display text-lg font-semibold">
        <CalendarClock size={18} />
        Cambios que pediste
      </h2>
      <ul className="divide-y">
        {recent.map((request) => {
          const status = STATUS_TEXT[request.status];
          return (
            <li key={request.id} className="space-y-1 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{request.clientName ?? 'Clienta'}</span>
                <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', status.tone)}>
                  {status.label}
                </span>
              </div>
              <p className="flex flex-wrap items-center gap-1.5 tabular-nums text-muted-foreground">
                {when(request.currentStartsAt)} <ArrowRight size={13} />
                <span className="text-foreground">
                  {when(request.proposedStartsAt)}
                </span>
              </p>
              {request.decisionNote && <p>«{request.decisionNote}»</p>}
              {request.status === 'PENDING' && (
                <Button
                  variant="ghost"
                  className="-ml-3"
                  disabled={busy === request.id}
                  onClick={() => withdraw(request.id)}
                >
                  Retirar petición
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
