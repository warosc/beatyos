'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Coffee, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { agendaSend } from './api';
import { dayLabel, time } from './time';
import { AGENDA_KEY } from './use-agenda';

const REASONS = ['Comida', 'Descanso', 'Formación', 'Recado', 'Reunión'];
const DURATIONS = [30, 60, 90, 120];

/**
 * Al tocar un hueco libre: agendar ahí o bloquearlo.
 *
 * Solo aparece para quien puede gestionar horarios; a los demás el toque los lleva
 * directamente a agendar, que es lo que buscan.
 */
export function SlotChoice({
  stylist,
  startsAt,
  onBook,
  onClose,
  onDone,
}: {
  stylist: { id: string; name: string; color: string };
  startsAt: Date;
  onBook: () => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('Comida');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function block() {
    setBusy(true);
    setError('');
    const result = await agendaSend('/api/agenda/blocks', 'POST', {
      stylistId: stylist.id,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString(),
      reason,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    await queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
    onDone(`Agenda de ${stylist.name} bloqueada: ${reason.toLowerCase()}.`);
  }

  return (
    <Sheet
      title={`${time(startsAt)} · ${stylist.name}`}
      description={<span className="first-letter:uppercase">{dayLabel(startsAt)}</span>}
      onClose={onClose}
    >
      {!blocking ? (
        <div className="grid gap-2">
          <Button className="h-14 justify-start text-base" onClick={onBook}>
            <CalendarPlus size={20} />
            Agendar una cita aquí
          </Button>
          <Button
            variant="outline"
            className="h-14 justify-start text-base"
            onClick={() => setBlocking(true)}
          >
            <Coffee size={20} />
            Bloquear este tiempo
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="text-sm font-semibold">Motivo</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {REASONS.map((item) => (
                <Chip key={item} selected={reason === item} onClick={() => setReason(item)}>
                  {item}
                </Chip>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-semibold">Duración</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {DURATIONS.map((item) => (
                <Chip key={item} selected={minutes === item} onClick={() => setMinutes(item)}>
                  {item < 60 ? `${item} min` : `${item / 60} h`}
                </Chip>
              ))}
            </div>
          </fieldset>
          <p className="text-sm text-muted-foreground">
            De {time(startsAt)} a {time(new Date(startsAt.getTime() + minutes * 60_000))}. Nadie
            podrá agendar con {stylist.name} en ese tramo.
          </p>
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setBlocking(false)}>
              Volver
            </Button>
            <Button disabled={busy} onClick={block}>
              Bloquear
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function BlockDetail({
  block,
  stylistName,
  canRemove,
  onClose,
  onDone,
}: {
  block: { id: string; stylistId: string; startsAt: Date; endsAt: Date; reason: string | null };
  stylistName: string;
  canRemove: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    setBusy(true);
    const result = await agendaSend(
      `/api/agenda/blocks/${encodeURIComponent(block.stylistId)}/${encodeURIComponent(block.id)}`,
      'DELETE',
    );
    setBusy(false);
    if (!result.ok) return setError(result.error);
    await queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
    onDone('Bloqueo quitado: el tramo vuelve a estar disponible.');
  }

  return (
    <Sheet
      title={block.reason ?? 'Tiempo bloqueado'}
      description={`${stylistName} · ${time(block.startsAt)} – ${time(block.endsAt)}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          En este tramo no se pueden agendar citas con {stylistName}.
        </p>
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        {canRemove && (
          <Button variant="outline" className="w-full text-danger" disabled={busy} onClick={remove}>
            <Trash2 size={16} />
            Quitar bloqueo
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'min-h-10 rounded-full border px-4 text-sm',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-card',
      )}
    >
      {children}
    </button>
  );
}
