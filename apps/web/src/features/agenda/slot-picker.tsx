'use client';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { agendaGet } from './api';
import { addDays, isoDay, sameDay, startOfDay, time } from './time';
import type { Slot } from './types';
import { AGENDA_KEY } from './use-agenda';

const DAYS_AHEAD = 28;

/**
 * Elegir día y hora sin poder elegir mal.
 *
 * Arriba, una franja de días que se desliza con el dedo; abajo, **solo** las horas libres
 * para esos servicios, agrupadas por mañana, tarde y noche. No hay campo de hora libre: lo
 * que no se ofrece no cabe, y así el choque con otra cita deja de ser un error que aparece
 * después de pulsar «Reservar».
 *
 * Sin profesional elegida, una hora sale si **alguna** puede; al tocarla se ofrece con
 * quién.
 */
export function SlotPicker({
  serviceIds,
  stylistId,
  excludeAppointmentId,
  day,
  onDayChange,
  value,
  onChange,
  stylistNames,
  preferredStartsAt,
}: {
  /** Hora tocada en la parrilla: si está libre, se marca sola al cargar. */
  preferredStartsAt?: string;
  serviceIds: string[];
  /** `null`: cualquier profesional que haga los servicios. */
  stylistId: string | null;
  excludeAppointmentId?: string;
  day: Date;
  onDayChange: (day: Date) => void;
  value: Slot | null;
  onChange: (slot: Slot | null) => void;
  stylistNames: Map<string, { name: string; color: string }>;
}) {
  // El día de hoy se fija al abrir el selector: la lista de días no cambia mientras se usa.
  const [today] = useState(() => startOfDay(new Date()));
  const days = useMemo(
    () => Array.from({ length: DAYS_AHEAD }, (_, index) => addDays(today, index)),
    [today],
  );

  const slots = useQuery({
    queryKey: [
      ...AGENDA_KEY,
      'availability',
      isoDay(day),
      serviceIds.join(','),
      stylistId ?? 'any',
      excludeAppointmentId ?? '',
    ],
    enabled: serviceIds.length > 0,
    queryFn: () =>
      agendaGet<Slot[]>('availability', {
        date: isoDay(day),
        serviceIds: serviceIds.join(','),
        ...(stylistId ? { stylistId } : {}),
        ...(excludeAppointmentId ? { excludeAppointmentId } : {}),
      }),
  });

  useEffect(() => {
    if (value || !preferredStartsAt || !slots.data) return;
    const preferred = new Date(preferredStartsAt).getTime();
    const match = slots.data.find((slot) => new Date(slot.startsAt).getTime() === preferred);
    if (match) onChange(match);
    // Solo al llegar los huecos: después, la elección es de quien agenda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.data]);

  // Una hora por fila aunque la tengan libre varias profesionales.
  const times = useMemo(() => {
    const byTime = new Map<string, Slot[]>();
    for (const slot of slots.data ?? []) {
      byTime.set(slot.startsAt, [...(byTime.get(slot.startsAt) ?? []), slot]);
    }
    return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [slots.data]);

  const groups = [
    { label: 'Mañana', from: 0, to: 12 },
    { label: 'Tarde', from: 12, to: 17 },
    { label: 'Noche', from: 17, to: 24 },
  ]
    .map((group) => ({
      ...group,
      items: times.filter(([iso]) => {
        const hour = new Date(iso).getHours();
        return hour >= group.from && hour < group.to;
      }),
    }))
    .filter((group) => group.items.length > 0);

  const alternatives = value ? (times.find(([iso]) => iso === value.startsAt)?.[1] ?? []) : [];

  return (
    <div className="space-y-4">
      <div
        role="listbox"
        aria-label="Día de la cita"
        className="-mx-5 flex snap-x gap-2 overflow-x-auto px-5 pb-1"
      >
        {days.map((candidate) => {
          const selected = sameDay(candidate, day);
          return (
            <button
              key={isoDay(candidate)}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => {
                onDayChange(candidate);
                onChange(null);
              }}
              className={cn(
                'flex min-h-16 w-14 shrink-0 snap-start flex-col items-center justify-center rounded-2xl border text-xs',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-card hover:bg-muted',
                candidate.getDay() === 0 && !selected && 'text-muted-foreground',
              )}
            >
              <span className="uppercase">
                {sameDay(candidate, today)
                  ? 'Hoy'
                  : candidate.toLocaleDateString('es-GT', { weekday: 'short' })}
              </span>
              <span className="text-lg font-semibold">{candidate.getDate()}</span>
            </button>
          );
        })}
      </div>

      {serviceIds.length === 0 ? (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          Elige primero los servicios: la duración decide qué horas caben.
        </p>
      ) : slots.isPending ? (
        <div className="grid grid-cols-4 gap-2" aria-busy="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="h-11 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : slots.error ? (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
          {slots.error.message}
        </p>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-muted p-6 text-center text-sm text-muted-foreground">
          <CalendarX2 />
          <p>No hay horas libres este día para estos servicios. Prueba con otro día.</p>
        </div>
      ) : (
        groups.map((group) => (
          <fieldset key={group.label}>
            <legend className="mb-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">
              {group.label}
            </legend>
            <div className="grid grid-cols-3 gap-2 min-[400px]:grid-cols-4">
              {group.items.map(([iso, options]) => {
                const selected = value?.startsAt === iso;
                return (
                  <button
                    key={iso}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      onChange(
                        selected
                          ? null
                          : (options.find((option) => option.stylistId === value?.stylistId) ??
                              options[0]),
                      )
                    }
                    className={cn(
                      'flex min-h-11 flex-col items-center justify-center rounded-xl border text-sm font-semibold tabular-nums',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'bg-card hover:border-primary',
                    )}
                  >
                    {time(iso)}
                    {!stylistId && (
                      <span className="flex gap-0.5 pt-0.5" aria-hidden>
                        {options.slice(0, 4).map((option) => (
                          <span
                            key={option.stylistId}
                            className="size-1.5 rounded-full"
                            style={{
                              background:
                                stylistNames.get(option.stylistId)?.color ?? 'currentColor',
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))
      )}

      {!stylistId && value && alternatives.length > 0 && (
        <div className="rounded-2xl border bg-muted/50 p-3">
          <p className="text-sm font-semibold">¿Con quién?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {alternatives.map((option) => {
              const person = stylistNames.get(option.stylistId);
              const selected = option.stylistId === value.stylistId;
              return (
                <button
                  key={option.stylistId}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChange(option)}
                  className={cn(
                    'inline-flex min-h-10 items-center gap-2 rounded-full border px-3 text-sm font-medium',
                    selected ? 'border-primary bg-card ring-2 ring-primary' : 'bg-card',
                  )}
                >
                  <span className="size-3 rounded-full" style={{ background: person?.color }} />
                  {person?.name ?? 'Profesional'}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
