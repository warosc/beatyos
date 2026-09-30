'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCircle2, Clock, Plus, Scissors, UserCheck, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Appointment } from '@/features/agenda/types';
import { RegisterServiceDialog } from '@/features/service-tickets/register-service-dialog';
import {
  money,
  problem,
  STATUS_LABEL,
  type AssignableService,
  type ServiceTicket,
} from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';
import { cn } from '@/lib/utils';
import { since } from './day';
import { MY_DAY_KEY, useMyDay } from './use-my-day';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

type Registering = { appointment: Appointment | null };

/**
 * «Mi día»: lo primero que ve la profesional, pensado para el móvil.
 *
 * Responde a una sola pregunta —¿a quién atiendo y qué me falta declarar?— y deja declarar
 * en dos toques. No cobra: lo que envía aparece en Caja, y aquí ve cuándo se cobró.
 */
export function MyDay() {
  const qc = useQueryClient();
  const { can, user } = useAccess();
  const allowed = can('service-tickets.create.own') || can('service-tickets.create');
  const { now, appointments, tickets, day } = useMyDay(allowed);
  const [registering, setRegistering] = useState<Registering | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Solo para poner nombre a los servicios reservados de cada cita.
  const services = useQuery({
    queryKey: ['assignable-services', 'me'],
    enabled: allowed,
    queryFn: async () => {
      const response = await sessionFetch('/api/service-tickets/assignable');
      if (!response.ok) return [];
      return ((await response.json()) as { data: AssignableService[] }).data;
    },
  });
  const serviceName = new Map(services.data?.map((service) => [service.id, service.name]));
  const bookedNames = (appointment: Appointment) =>
    appointment.services
      .map((line) => serviceName.get(line.serviceId))
      .filter(Boolean)
      .join(' · ') || 'Servicio reservado';

  if (!allowed) {
    return (
      <p role="alert" className="p-8 text-center text-sm text-muted-foreground">
        Esta sección es para quien atiende clientas.
      </p>
    );
  }

  const refresh = () => qc.invalidateQueries({ queryKey: MY_DAY_KEY });

  async function arrived(appointment: Appointment) {
    setError('');
    const response = await sessionFetch(`/api/agenda/${appointment.id}?action=start`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return setError(await problem(response, 'No se pudo iniciar la cita.'));
    await refresh();
  }

  const loading = appointments.isPending || tickets.isPending;
  const empty = !day.now.length && !day.overdue.length && !day.upcoming.length;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <p className="text-sm font-medium text-primary first-letter:uppercase">
          {now.toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <h1 className="mt-1 font-display text-4xl font-semibold">
          Hola{user?.firstName ? `, ${user.firstName}` : ''}
        </h1>
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
      {(error || appointments.error) && (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {error || appointments.error?.message}
        </p>
      )}

      {day.now.map((appointment) => (
        <Card key={appointment.id} className="border-2 border-primary p-5">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-primary uppercase">
            <Scissors size={14} />
            Atendiendo ahora
          </p>
          <p className="mt-2 font-display text-2xl font-semibold">
            {appointment.clientName ?? 'Clienta'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {time(appointment.startsAt)} – {time(appointment.endsAt)} · {bookedNames(appointment)}
          </p>
          <Button
            className="mt-4 h-14 w-full text-base"
            onClick={() => setRegistering({ appointment })}
          >
            Registrar lo que le hice
          </Button>
        </Card>
      ))}

      {day.overdue.length > 0 && (
        <Card className="overflow-hidden border-warning/60">
          <h2 className="flex items-center gap-2 border-b bg-warning/10 p-4 text-sm font-bold text-warning">
            <BellRing size={16} />
            Falta registrar ({day.overdue.length})
          </h2>
          <ul className="divide-y">
            {day.overdue.map((appointment) => (
              <li key={appointment.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{appointment.clientName ?? 'Clienta'}</p>
                  <p className="text-sm text-muted-foreground">
                    {time(appointment.startsAt)} · terminó {since(appointment.endsAt, now)}
                  </p>
                </div>
                <Button onClick={() => setRegistering({ appointment })}>Registrar</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Button
        variant="outline"
        className="h-12 w-full"
        onClick={() => setRegistering({ appointment: null })}
      >
        <Plus size={18} />
        Clienta sin cita
      </Button>

      <Card className="overflow-hidden">
        <h2 className="flex items-center gap-2 border-b p-4 font-display text-lg font-semibold">
          <Clock size={18} />
          Siguientes
        </h2>
        {day.upcoming.length ? (
          <ul className="divide-y">
            {day.upcoming.map((appointment) => (
              <li key={appointment.id} className="flex items-center gap-3 p-4">
                <span className="shrink-0 text-sm font-bold whitespace-nowrap tabular-nums">
                  {time(appointment.startsAt)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{appointment.clientName ?? 'Clienta'}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {bookedNames(appointment)}
                  </p>
                </div>
                {can('appointments.update.own') || can('appointments.update') ? (
                  <Button variant="ghost" onClick={() => arrived(appointment)}>
                    <UserCheck size={16} />
                    Llegó
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {loading
              ? 'Cargando tu agenda…'
              : empty
                ? 'No tienes citas para hoy.'
                : 'No tienes más citas hoy.'}
          </p>
        )}
      </Card>

      <Card className="overflow-hidden">
        <h2 className="border-b p-4 font-display text-lg font-semibold">Enviado a caja hoy</h2>
        {tickets.data?.length ? (
          <ul className="divide-y">
            {tickets.data.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} onChanged={refresh} />
            ))}
          </ul>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {tickets.isPending ? 'Cargando…' : 'Todavía no has enviado servicios a caja.'}
          </p>
        )}
      </Card>

      {registering && (
        <RegisterServiceDialog
          appointment={registering.appointment}
          onClose={() => setRegistering(null)}
          onDone={async (ticket) => {
            setRegistering(null);
            setNotice(`Enviado a caja: ${ticket.clientName} · ${money(ticket.total)}`);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function TicketRow({ ticket, onChanged }: { ticket: ServiceTicket; onChanged: () => void }) {
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

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await sessionFetch(`/api/service-tickets/${ticket.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!response.ok) return setError(await problem(response, 'No pudimos anular el servicio.'));
    setCancelling(false);
    onChanged();
  }

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-40">
          <p className="font-semibold">{ticket.clientName}</p>
          <p className="text-sm text-muted-foreground">
            {time(ticket.createdAt)} · {ticket.lines.map((line) => line.name).join(', ')}
          </p>
        </div>
        <strong className="tabular-nums">{money(ticket.total)}</strong>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
            tone,
          )}
        >
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
            onChange={(event) => setReason(event.target.value)}
            placeholder="Motivo de la anulación"
            aria-label="Motivo de la anulación"
            className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-sm"
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
    </li>
  );
}
