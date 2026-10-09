'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, CalendarX2, Clock, Scissors, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { problem } from '@/features/service-tickets/types';
import { dayLabel, time } from './time';

interface PublicAppointment {
  salonName: string;
  clientFirstName: string;
  stylistName: string;
  serviceNames: string[];
  startsAt: string;
  endsAt: string;
  status: string;
  canConfirm: boolean;
  canCancel: boolean;
}

/**
 * Lo que ve la clienta al tocar el enlace del recordatorio.
 *
 * Una pantalla, dos botones. Sin cuenta, sin contraseña y sin nada que instalar: lo abre
 * desde WhatsApp en su teléfono, confirma con un toque y ya. Si cancela, el hueco aparece
 * libre en la agenda del salón al momento.
 */
export function AppointmentLink({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const key = ['public-appointment', token];
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'confirmed' | 'cancelled' | null>(null);

  const appointment = useQuery({
    queryKey: key,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`/api/public/appointment-links/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(await problem(response, 'Este enlace no es válido.'));
      return ((await response.json()) as { data: PublicAppointment }).data;
    },
  });

  async function act(action: 'confirm' | 'cancel') {
    setBusy(true);
    setError('');
    const response = await fetch(
      `/api/public/appointment-links/${encodeURIComponent(token)}?action=${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'cancel' && reason.trim() ? { reason: reason.trim() } : {}),
      },
    );
    setBusy(false);
    if (!response.ok) return setError(await problem(response, 'No pudimos guardar tu respuesta.'));
    queryClient.setQueryData(key, ((await response.json()) as { data: PublicAppointment }).data);
    setDone(action === 'confirm' ? 'confirmed' : 'cancelled');
    setCancelling(false);
  }

  const data = appointment.data;

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4">
      <div className="w-full max-w-md space-y-5 rounded-3xl border bg-card p-6 shadow-sm">
        {appointment.isPending ? (
          <p role="status" className="text-center text-sm text-muted-foreground">
            Cargando tu cita…
          </p>
        ) : appointment.error || !data ? (
          <div className="space-y-2 text-center">
            <CalendarX2 className="mx-auto text-muted-foreground" size={36} />
            <h1 className="font-display text-2xl font-semibold">Enlace no válido</h1>
            <p className="text-sm text-muted-foreground">
              Puede que el salón te haya enviado uno más reciente. Si tienes dudas, llámales.
            </p>
          </div>
        ) : (
          <>
            <div>
              <p className="text-sm font-medium text-primary">{data.salonName}</p>
              <h1 className="mt-1 font-display text-3xl font-semibold">
                Hola, {data.clientFirstName}
              </h1>
            </div>

            <dl className="space-y-3 rounded-2xl bg-muted p-4 text-sm">
              <div className="flex items-center gap-3">
                <dt>
                  <CalendarCheck2 size={18} aria-label="Día" />
                </dt>
                <dd className="font-semibold first-letter:uppercase">
                  {dayLabel(new Date(data.startsAt))}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt>
                  <Clock size={18} aria-label="Hora" />
                </dt>
                <dd className="font-semibold tabular-nums">
                  {time(data.startsAt)} – {time(data.endsAt)}
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt>
                  <UserRound size={18} aria-label="Con" />
                </dt>
                <dd>Con {data.stylistName}</dd>
              </div>
              {data.serviceNames.length > 0 && (
                <div className="flex items-center gap-3">
                  <dt>
                    <Scissors size={18} aria-label="Servicios" />
                  </dt>
                  <dd>{data.serviceNames.join(', ')}</dd>
                </div>
              )}
            </dl>

            {data.status === 'CONFIRMED' && (
              <p
                role="status"
                className="rounded-xl bg-success/10 p-3 text-center font-semibold text-success"
              >
                {done === 'confirmed'
                  ? '¡Gracias! Tu cita está confirmada.'
                  : 'Tu cita está confirmada.'}
              </p>
            )}
            {data.status === 'CANCELLED' && (
              <p role="status" className="rounded-xl bg-muted p-3 text-center text-sm">
                {done === 'cancelled'
                  ? 'Listo, cancelamos tu cita. Cuando quieras, agenda otra con el salón.'
                  : 'Esta cita está cancelada.'}
              </p>
            )}
            {!data.canConfirm &&
              !data.canCancel &&
              data.status !== 'CANCELLED' &&
              data.status !== 'CONFIRMED' && (
                <p className="rounded-xl bg-muted p-3 text-center text-sm">
                  Esta cita ya no se puede cambiar desde aquí.
                </p>
              )}

            {error && (
              <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
                {error}
              </p>
            )}

            {cancelling ? (
              <div className="space-y-3">
                <label className="block text-sm font-semibold">
                  ¿Nos cuentas por qué?{' '}
                  <span className="font-normal text-muted-foreground">(opcional)</span>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={300}
                    className="mt-1.5 h-12 w-full rounded-xl border bg-background px-3 text-base"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="ghost" className="h-12" onClick={() => setCancelling(false)}>
                    Volver
                  </Button>
                  <Button
                    className="h-12 bg-danger text-white hover:bg-danger/90"
                    disabled={busy}
                    onClick={() => act('cancel')}
                  >
                    Sí, cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
                {data.canConfirm && (
                  <Button className="h-14 text-base" disabled={busy} onClick={() => act('confirm')}>
                    Confirmo que voy
                  </Button>
                )}
                {data.canCancel && (
                  <Button variant="outline" className="h-12" onClick={() => setCancelling(true)}>
                    No puedo ir, cancelar
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
