'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  Copy,
  MessageCircle,
  Phone,
  Scissors,
  Send,
  StickyNote,
  UserCheck,
  UserX,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import {
  STATUS_LABEL as TICKET_STATUS,
  type ServiceTicket,
} from '@/features/service-tickets/types';
import { loadPage } from '@/lib/pagination';
import { cn, money } from '@/lib/utils';
import { agendaSend, appointmentAction } from './api';
import { SlotPicker } from './slot-picker';
import { CANCEL_REASONS, statusMeta } from './status';
import { addDays, dayLabel, startOfDay, time } from './time';
import type { Appointment, Slot, StylistShifts } from './types';
import { AGENDA_KEY, PENDING_CHANGES_KEY } from './use-agenda';

type Panel = 'none' | 'move' | 'request' | 'cancel' | 'notes';

const dayBounds = (iso: string) => {
  const start = startOfDay(new Date(iso));
  return `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(addDays(start, 1).toISOString())}`;
};

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  SMS: 'SMS',
  LOG: 'simulado (sin proveedor)',
  MANUAL: 'WhatsApp desde recepción',
};

/**
 * Ficha de una cita y todo lo que se puede hacer con ella.
 *
 * Las acciones se ordenan por lo que toca **ahora**: una cita pendiente pide confirmarse;
 * una de hoy que llega, marcar la llegada; una en curso, registrar lo que se hizo. Lo
 * menos frecuente —mover, cancelar— queda debajo, y cada bloque aparece solo si quien mira
 * tiene permiso para usarlo.
 */
export function AppointmentSheet({
  appointment,
  team,
  onClose,
  onRegister,
  onDone,
}: {
  appointment: Appointment;
  team: StylistShifts[];
  onClose: () => void;
  onRegister: () => void;
  onDone: (message: string) => void;
}) {
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reminder, setReminder] = useState<{ message: string; whatsappUrl: string | null } | null>(
    null,
  );

  const meta = statusMeta(appointment.status);
  const start = new Date(appointment.startsAt);
  // La hora de apertura de la ficha basta: se abre y se cierra en segundos.
  const [openedAt] = useState(() => Date.now());
  const started = start.getTime() <= openedAt;
  const canUpdate = can('appointments.update');
  const canUpdateOwn = can('appointments.update.own');
  const canApprove = can('appointments.approve-changes');
  const pendable = appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED';
  const attendable = pendable || appointment.status === 'IN_PROGRESS';
  // Una cita realizada también puede ir a caja —o ya haber ido—: recepción tiene que ver
  // si se cobró, y si alguien la marcó realizada por error, todavía poder enviarla.
  const ticketable = attendable || appointment.status === 'COMPLETED';
  const canRegister = can('service-tickets.create') || can('service-tickets.create.own');
  const stylist = team.find((member) => member.stylistId === appointment.stylistId);
  const stylistName = appointment.stylistName ?? stylist?.name ?? 'Profesional';
  const stylistColor = appointment.stylistColor ?? stylist?.color ?? 'var(--primary)';

  const tickets = useQuery({
    queryKey: ['agenda-tickets', dayBounds(appointment.startsAt)],
    enabled: ticketable && (can('service-tickets.read') || can('service-tickets.read.own')),
    queryFn: ({ signal }) =>
      loadPage<ServiceTicket>(
        `/api/service-tickets?limit=100&${dayBounds(appointment.startsAt)}`,
        signal,
      ).then((page) => page.data),
  });
  const ticket = tickets.data?.find(
    (item) => item.appointmentId === appointment.id && item.status !== 'CANCELLED',
  );

  async function run(
    work: () => Promise<{ ok: true } | { ok: false; error: string }>,
    message: string,
  ) {
    setBusy(true);
    setError('');
    const result = await work();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: AGENDA_KEY }),
      queryClient.invalidateQueries({ queryKey: PENDING_CHANGES_KEY }),
    ]);
    onDone(message);
  }

  async function prepareReminder() {
    setBusy(true);
    setError('');
    const result = await appointmentAction<{ message: string; whatsappUrl: string | null }>(
      appointment.id,
      'reminder',
    );
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setReminder(result.data);
    void queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
  }

  const services = appointment.services
    .map((line) => line.name)
    .filter(Boolean)
    .join(' · ');
  const phoneDigits = appointment.clientPhone?.replace(/\D/g, '') ?? '';

  return (
    <Sheet
      title={appointment.clientName ?? 'Clienta'}
      onClose={onClose}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="first-letter:uppercase">{dayLabel(start, { month: 'short' })}</span>·
          <span className="tabular-nums">
            {time(appointment.startsAt)} – {time(appointment.endsAt)}
          </span>
        </span>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-3 py-1 text-xs font-semibold', meta.badge)}>
            {meta.label}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium">
            <span className="size-2.5 rounded-full" style={{ background: stylistColor }} />
            {stylistName}
          </span>
          <span className="ml-auto text-sm font-semibold tabular-nums">
            {money(appointment.estimatedTotal)}
          </span>
        </div>

        <p className="text-sm">{services || 'Servicio reservado'}</p>

        {appointment.status === 'CANCELLED' && appointment.cancellationReason && (
          <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
            {appointment.cancellationReason}
          </p>
        )}

        {appointment.internalNotes && panel !== 'notes' && (
          <p className="flex gap-2 rounded-xl bg-secondary p-3 text-sm text-secondary-foreground">
            <StickyNote size={16} className="mt-0.5 shrink-0" />
            {appointment.internalNotes}
          </p>
        )}

        {phoneDigits && (
          <div className="grid grid-cols-2 gap-2">
            <a
              href={`tel:${appointment.clientPhone}`}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border bg-card text-sm font-semibold hover:bg-muted"
            >
              <Phone size={16} />
              Llamar
            </a>
            <a
              href={`https://wa.me/${phoneDigits.length <= 8 ? `502${phoneDigits}` : phoneDigits}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border bg-card text-sm font-semibold hover:bg-muted"
            >
              <MessageCircle size={16} />
              WhatsApp
            </a>
          </div>
        )}

        {appointment.pendingChange && (
          <PendingChange
            appointment={appointment}
            stylistName={stylistName}
            canApprove={canApprove}
            canWithdraw={!canUpdate && canUpdateOwn}
            busy={busy}
            onDecide={(action, note) =>
              run(
                () =>
                  agendaSend(
                    `/api/agenda/change-requests/${appointment.pendingChange!.id}/${action}`,
                    'PATCH',
                    note ? { note } : {},
                  ),
                action === 'approve'
                  ? 'Cambio aprobado: la cita se movió.'
                  : action === 'reject'
                    ? 'Cambio rechazado: la cita sigue a su hora.'
                    : 'Retiraste tu petición de cambio.',
              )
            }
          />
        )}

        {/* Lo que toca ahora, según el estado. */}
        {ticketable && (
          <div className="space-y-2">
            {ticket ? (
              <p className="flex items-center gap-2 rounded-xl bg-success/10 p-3 text-sm font-medium text-success">
                <CheckCircle2 size={16} />
                Enviado a caja · {TICKET_STATUS[ticket.status]}
              </p>
            ) : (
              canRegister &&
              (started ||
                appointment.status === 'IN_PROGRESS' ||
                appointment.status === 'COMPLETED') && (
                <Button className="h-12 w-full" disabled={busy} onClick={onRegister}>
                  <Scissors size={17} />
                  Registrar lo realizado
                </Button>
              )
            )}
            {attendable && (
              <div className="grid grid-cols-2 gap-2">
                {canUpdate && appointment.status === 'SCHEDULED' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(() => appointmentAction(appointment.id, 'confirm'), 'Cita confirmada.')
                    }
                  >
                    <CheckCircle2 size={17} />
                    Confirmar
                  </Button>
                )}
                {!ticket && pendable && (canUpdate || canUpdateOwn) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(() => appointmentAction(appointment.id, 'start'), 'Atención iniciada.')
                    }
                  >
                    <UserCheck size={17} />
                    Llegó
                  </Button>
                )}
                {canUpdate && pendable && started && (
                  <Button
                    variant="outline"
                    className="text-danger"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => appointmentAction(appointment.id, 'no-show'),
                        'Marcada como «no vino».',
                      )
                    }
                  >
                    <UserX size={17} />
                    No vino
                  </Button>
                )}
                {/* Cerrar la cita sin enviar a caja: un retoque sin cobro, una cortesía. Lo
                  habitual es «Registrar lo realizado», que además la cobra. */}
                {/* La profesional también: la API se lo permite en sus propias citas. */}
                {!ticket &&
                  (canUpdate || canUpdateOwn) &&
                  (started || appointment.status === 'IN_PROGRESS') && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => appointmentAction(appointment.id, 'complete'),
                          'Cita marcada como realizada.',
                        )
                      }
                    >
                      <CheckCircle2 size={17} />
                      Marcar como realizada
                    </Button>
                  )}
              </div>
            )}
          </div>
        )}

        {/* Recordatorio a la clienta. */}
        {pendable && !started && (
          <ReminderBlock
            appointment={appointment}
            canSend={canUpdate}
            busy={busy}
            prepared={reminder}
            onPrepare={prepareReminder}
          />
        )}

        {/* Mover: recepción y encargada directamente; la profesional, pidiéndolo. */}
        {pendable && (canUpdate || (canUpdateOwn && !appointment.pendingChange)) && (
          <div className="border-t pt-4">
            {panel === 'move' || panel === 'request' ? (
              <MovePanel
                appointment={appointment}
                team={team}
                mode={panel}
                busy={busy}
                onCancel={() => setPanel('none')}
                onSubmit={(slot, reason) =>
                  panel === 'move'
                    ? run(
                        () =>
                          appointmentAction(appointment.id, 'reschedule', {
                            startsAt: slot.startsAt,
                            ...(slot.stylistId !== appointment.stylistId
                              ? { stylistId: slot.stylistId }
                              : {}),
                          }),
                        'Cita movida.',
                      )
                    : run(
                        () =>
                          appointmentAction(appointment.id, 'change-request', {
                            startsAt: slot.startsAt,
                            ...(reason ? { reason } : {}),
                          }),
                        'Petición enviada a la encargada. Te avisamos cuando responda.',
                      )
                }
              />
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setPanel(canUpdate ? 'move' : 'request')}
              >
                <CalendarClock size={17} />
                {canUpdate ? 'Mover a otra hora o profesional' : 'Pedir cambio de hora'}
              </Button>
            )}
          </div>
        )}

        {(canUpdate || canUpdateOwn) && (
          <NotesBlock
            appointment={appointment}
            open={panel === 'notes'}
            busy={busy}
            onOpen={() => setPanel('notes')}
            onCancel={() => setPanel('none')}
            onSave={(internalNotes) =>
              run(
                () => appointmentAction(appointment.id, 'notes', { internalNotes }),
                'Nota guardada.',
              )
            }
          />
        )}

        {/* También en curso: la clienta puede irse a mitad (el dominio lo admite). */}
        {can('appointments.cancel') && attendable && (
          <CancelBlock
            open={panel === 'cancel'}
            busy={busy}
            onOpen={() => setPanel('cancel')}
            onCancel={() => setPanel('none')}
            onConfirm={(reason) =>
              run(
                () => appointmentAction(appointment.id, 'cancel', reason ? { reason } : {}),
                'Cita cancelada. El hueco quedó libre.',
              )
            }
          />
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function PendingChange({
  appointment,
  stylistName,
  canApprove,
  canWithdraw,
  busy,
  onDecide,
}: {
  appointment: Appointment;
  stylistName: string;
  canApprove: boolean;
  canWithdraw: boolean;
  busy: boolean;
  onDecide: (action: 'approve' | 'reject' | 'withdraw', note?: string) => void;
}) {
  const [note, setNote] = useState('');
  const change = appointment.pendingChange!;
  return (
    <div className="space-y-3 rounded-2xl border border-warning/60 bg-warning/10 p-4">
      <p className="flex items-start gap-2 text-sm">
        <CalendarClock size={18} className="mt-0.5 shrink-0 text-warning" />
        <span>
          <strong>{canWithdraw ? 'Pediste' : `${stylistName} pide`}</strong> moverla al{' '}
          <strong className="first-letter:uppercase">
            {dayLabel(new Date(change.proposedStartsAt), { month: 'short' })} a las{' '}
            {time(change.proposedStartsAt)}
          </strong>
          .{change.reason && <span className="block text-muted-foreground">«{change.reason}»</span>}
          {canWithdraw && (
            <span className="block text-muted-foreground">Esperando a la encargada.</span>
          )}
        </span>
      </p>
      {canApprove && (
        <>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            placeholder="Nota para la profesional (opcional)"
            aria-label="Nota para la profesional"
            className="h-11 w-full rounded-xl border bg-background px-3 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={() => onDecide('approve', note)}>
              <CheckCircle2 size={17} />
              Aprobar y mover
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => onDecide('reject', note)}>
              <XCircle size={17} />
              Rechazar
            </Button>
          </div>
        </>
      )}
      {canWithdraw && (
        <Button variant="ghost" disabled={busy} onClick={() => onDecide('withdraw')}>
          Retirar petición
        </Button>
      )}
    </div>
  );
}

function ReminderBlock({
  appointment,
  canSend,
  busy,
  prepared,
  onPrepare,
}: {
  appointment: Appointment;
  canSend: boolean;
  busy: boolean;
  prepared: { message: string; whatsappUrl: string | null } | null;
  onPrepare: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const last = appointment.lastReminder;
  const status = !last
    ? 'Sin recordatorio todavía. Sale solo el día antes.'
    : last.status === 'SENT'
      ? `Recordatorio enviado · ${CHANNEL_LABEL[last.channel] ?? last.channel} · ${new Date(last.at).toLocaleString('es-GT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : last.status === 'SKIPPED'
        ? 'No se pudo recordar: la clienta no tiene teléfono.'
        : `El último recordatorio falló${last.error ? `: ${last.error}` : ''}.`;

  return (
    <div className="space-y-2 rounded-2xl border p-3">
      <p className="flex items-start gap-2 text-sm">
        <BellRing
          size={16}
          className={cn(
            'mt-0.5 shrink-0',
            last?.status === 'SENT'
              ? 'text-success'
              : last
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
        />
        {status}
      </p>
      {canSend && !prepared && (
        <Button variant="outline" className="w-full" disabled={busy} onClick={onPrepare}>
          <Send size={16} />
          {last?.status === 'SENT' ? 'Volver a recordar' : 'Recordar por WhatsApp'}
        </Button>
      )}
      {prepared && (
        <div className="space-y-2">
          <p className="rounded-xl bg-muted p-3 text-xs whitespace-pre-line">{prepared.message}</p>
          <div className="grid grid-cols-2 gap-2">
            {prepared.whatsappUrl ? (
              <a
                href={prepared.whatsappUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-success text-sm font-semibold text-white"
              >
                <MessageCircle size={16} />
                Abrir WhatsApp
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">
                La clienta no tiene un teléfono válido.
              </span>
            )}
            <Button
              variant="outline"
              onClick={async () => {
                await navigator.clipboard?.writeText(prepared.message).catch(() => undefined);
                setCopied(true);
              }}
            >
              <Copy size={16} />
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MovePanel({
  appointment,
  team,
  mode,
  busy,
  onCancel,
  onSubmit,
}: {
  appointment: Appointment;
  team: StylistShifts[];
  mode: 'move' | 'request';
  busy: boolean;
  onCancel: () => void;
  onSubmit: (slot: Slot, reason?: string) => void;
}) {
  const serviceIds = appointment.services.map((line) => line.serviceId);
  const [stylistId, setStylistId] = useState(appointment.stylistId);
  const [day, setDay] = useState(startOfDay(new Date(appointment.startsAt)));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const names = useMemo(
    () =>
      new Map(team.map((member) => [member.stylistId, { name: member.name, color: member.color }])),
    [team],
  );
  const capable = team.filter(
    (member) =>
      member.isBookable &&
      serviceIds.every((id) => member.serviceIds.length === 0 || member.serviceIds.includes(id)),
  );

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">
        {mode === 'move' ? 'Mover la cita' : 'Pedir cambio de hora'}
      </h3>
      {mode === 'request' && (
        <p className="text-sm text-muted-foreground">
          La encargada recibe tu petición y decide. La cita no se mueve hasta que la apruebe.
        </p>
      )}
      {mode === 'move' && capable.length > 1 && (
        <div className="-mx-1 flex flex-wrap gap-2">
          {capable.map((member) => (
            <button
              key={member.stylistId}
              type="button"
              aria-pressed={stylistId === member.stylistId}
              onClick={() => {
                setStylistId(member.stylistId);
                setSlot(null);
              }}
              className={cn(
                'inline-flex min-h-10 items-center gap-2 rounded-full border px-3 text-sm',
                stylistId === member.stylistId ? 'ring-2 ring-primary' : 'bg-card',
              )}
            >
              <span className="size-3 rounded-full" style={{ background: member.color }} />
              {member.name}
            </button>
          ))}
        </div>
      )}
      <SlotPicker
        serviceIds={serviceIds}
        stylistId={stylistId}
        excludeAppointmentId={appointment.id}
        day={day}
        onDayChange={setDay}
        value={slot}
        onChange={setSlot}
        stylistNames={names}
      />
      {mode === 'request' && (
        <label className="block text-sm font-semibold">
          Motivo <span className="font-normal text-muted-foreground">(opcional)</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Ej.: la clienta pidió venir más tarde"
            className="mt-1.5 h-11 w-full rounded-xl border bg-background px-3 text-sm"
          />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Volver
        </Button>
        <Button
          disabled={
            busy ||
            !slot ||
            (slot.startsAt === new Date(appointment.startsAt).toISOString() &&
              slot.stylistId === appointment.stylistId)
          }
          onClick={() => slot && onSubmit(slot, reason.trim() || undefined)}
        >
          {mode === 'move' ? 'Mover aquí' : 'Enviar petición'}
        </Button>
      </div>
    </div>
  );
}

function NotesBlock({
  appointment,
  open,
  busy,
  onOpen,
  onCancel,
  onSave,
}: {
  appointment: Appointment;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSave: (notes: string) => void;
}) {
  const [value, setValue] = useState(appointment.internalNotes ?? '');
  if (!open) {
    return (
      <Button variant="ghost" className="w-full" onClick={onOpen}>
        <StickyNote size={16} />
        {appointment.internalNotes ? 'Editar nota del equipo' : 'Añadir nota del equipo'}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold">
        Nota del equipo
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="Fórmula de color, preferencias, avisos…"
          className="mt-1.5 w-full rounded-xl border bg-background p-3 text-sm"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Volver
        </Button>
        <Button disabled={busy} onClick={() => onSave(value)}>
          Guardar nota
        </Button>
      </div>
    </div>
  );
}

function CancelBlock({
  open,
  busy,
  onOpen,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <Button variant="ghost" className="w-full text-danger" onClick={onOpen}>
        <XCircle size={16} />
        Cancelar cita
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-2xl border border-danger/40 p-4">
      <p className="text-sm font-semibold">¿Por qué se cancela?</p>
      <p className="text-xs text-muted-foreground">
        El hueco queda libre y no se puede deshacer: si la clienta vuelve a llamar, se reserva una
        cita nueva.
      </p>
      <div className="flex flex-wrap gap-2">
        {CANCEL_REASONS.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={reason === item}
            onClick={() => setReason(item)}
            className={cn(
              'min-h-9 rounded-full border px-3 text-xs',
              reason === item ? 'border-danger bg-danger/10 text-danger' : 'bg-card',
            )}
          >
            {item}
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={500}
        placeholder="U otro motivo"
        aria-label="Motivo de cancelación"
        className="h-11 w-full rounded-xl border bg-background px-3 text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Volver
        </Button>
        <Button
          className="bg-danger text-white hover:bg-danger/90"
          disabled={busy}
          onClick={() => onConfirm(reason.trim())}
        >
          Sí, cancelar
        </Button>
      </div>
    </div>
  );
}
