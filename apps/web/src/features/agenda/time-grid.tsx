'use client';
import { BellRing, CalendarClock, Coffee, StickyNote } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { statusMeta } from './status';
import {
  atMinutes,
  hourLabel,
  layoutLanes,
  minutesInDay,
  sameDay,
  shortTime,
  snap,
  time,
} from './time';
import type { Appointment } from './types';

export interface GridColumn {
  key: string;
  header: ReactNode;
  day: Date;
  /** Profesional de la columna; `null` en la vista de semana, donde se mezclan. */
  stylistId: string | null;
  /** Tramos de jornada, en minutos desde medianoche. Lo demás se sombrea. */
  working: { start: number; end: number }[];
  blocks: { id: string; stylistId: string; start: number; end: number; reason: string | null }[];
  appointments: Appointment[];
}

/** Píxeles por hora. Con 72, un cuarto de hora mide 18 px: se puede tocar con el dedo. */
export const HOUR_HEIGHT = 72;
const px = (minutes: number) => (minutes / 60) * HOUR_HEIGHT;

/**
 * Parrilla horaria con columnas.
 *
 * Sirve a las dos vistas que importan en un salón: el **día con una columna por
 * profesional** —lo que mira la encargada para saber quién está libre— y la **semana con
 * una columna por día**. Las citas se colocan a su hora y miden lo que duran; lo que no es
 * jornada sale sombreado, y los bloqueos, rayados con su motivo.
 *
 * Tocar un hueco libre propone agendar ahí. En escritorio, una cita se arrastra a otra hora
 * o a otra columna; en el móvil se mueve desde su ficha, que es más fiable con el dedo.
 */
export function TimeGrid({
  columns,
  range,
  canDrag,
  onSelect,
  onEmpty,
  onMove,
  onBlock,
  minColumnWidth = 150,
}: {
  columns: GridColumn[];
  range: { start: number; end: number };
  canDrag: boolean;
  onSelect: (appointment: Appointment) => void;
  onEmpty?: (column: GridColumn, startsAt: Date) => void;
  onMove?: (appointment: Appointment, column: GridColumn, startsAt: Date) => void;
  onBlock?: (block: GridColumn['blocks'][number]) => void;
  minColumnWidth?: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  const [dragging, setDragging] = useState<{ appointment: Appointment; offset: number } | null>(
    null,
  );
  const [ghost, setGhost] = useState<{ column: string; minutes: number } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Al abrir, la parrilla baja sola hasta la hora actual —o al principio de la jornada—:
  // nadie quiere desplazarse desde las 8:00 cada vez que mira a las 16:00.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !scroller.current) return;
    scrolled.current = true;
    const today = columns.some((column) => sameDay(column.day, now));
    const target = today ? minutesInDay(now, now) - 60 : range.start;
    scroller.current.scrollTop = Math.max(0, px(target - range.start));
  }, [columns, now, range.start]);

  const height = px(range.end - range.start);
  const hours = Array.from(
    { length: (range.end - range.start) / 60 },
    (_, index) => range.start + index * 60,
  );

  const pointerMinutes = (event: React.MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return range.start + ((event.clientY - box.top) / HOUR_HEIGHT) * 60;
  };

  return (
    <div
      ref={scroller}
      className="relative max-h-[calc(100dvh-15rem)] min-h-[420px] overflow-auto overscroll-contain"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `3.25rem repeat(${columns.length}, minmax(${minColumnWidth}px, 1fr))`,
        }}
      >
        {/* Cabecera fija al desplazar en vertical. */}
        <div className="sticky top-0 left-0 z-30 border-b bg-card" />
        {columns.map((column) => (
          <div
            key={column.key}
            className="sticky top-0 z-20 border-b border-l bg-card px-2 py-2 text-center"
          >
            {column.header}
          </div>
        ))}

        {/* Horas, fijas al desplazar en horizontal. */}
        <div className="sticky left-0 z-10 bg-card" style={{ height }}>
          {hours.map((minutes) => (
            <span
              key={minutes}
              className="absolute right-1.5 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums"
              style={{ top: px(minutes - range.start) }}
            >
              {minutes === range.start ? '' : hourLabel(minutes)}
            </span>
          ))}
        </div>

        {columns.map((column) => {
          const isToday = sameDay(column.day, now);
          const nowMinutes = minutesInDay(now, column.day);
          const laid = layoutLanes(column.appointments);
          return (
            <div
              key={column.key}
              role="presentation"
              className="relative border-l bg-muted/70"
              style={{
                height,
                backgroundImage:
                  'repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px 100%)',
                backgroundSize: `100% ${HOUR_HEIGHT}px`,
              }}
              onClick={(event) => {
                if (!onEmpty || event.target !== event.currentTarget) return;
                const minutes = snap(pointerMinutes(event) - 7, 15);
                onEmpty(column, atMinutes(column.day, minutes));
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                const minutes = snap(pointerMinutes(event) - dragging.offset, 15);
                setGhost({ column: column.key, minutes });
              }}
              onDragLeave={() => setGhost(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (!dragging || !onMove) return;
                const minutes = snap(pointerMinutes(event) - dragging.offset, 15);
                onMove(dragging.appointment, column, atMinutes(column.day, minutes));
                setDragging(null);
                setGhost(null);
              }}
            >
              {/* Jornada: fondo claro sobre el sombreado de «fuera de horario». */}
              {column.working.map((interval) => (
                <div
                  key={`${interval.start}-${interval.end}`}
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bg-card"
                  style={{
                    top: px(interval.start - range.start),
                    height: px(interval.end - interval.start),
                    backgroundImage:
                      'repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px 100%)',
                    backgroundSize: `100% ${HOUR_HEIGHT}px`,
                    backgroundPositionY: `${-px(interval.start - range.start) % HOUR_HEIGHT}px`,
                  }}
                />
              ))}

              {column.blocks.map((block) => (
                <button
                  key={block.id}
                  type="button"
                  onClick={() => onBlock?.(block)}
                  className="absolute inset-x-1 flex items-start gap-1 overflow-hidden rounded-lg border border-dashed px-2 py-1 text-left text-[11px] text-muted-foreground"
                  style={{
                    top: px(block.start - range.start),
                    height: Math.max(px(block.end - block.start), 20),
                    backgroundImage:
                      'repeating-linear-gradient(135deg, var(--muted) 0 6px, transparent 6px 12px)',
                  }}
                >
                  <Coffee size={12} className="mt-0.5 shrink-0" />
                  <span className="truncate">{block.reason ?? 'Bloqueado'}</span>
                </button>
              ))}

              {laid.map(({ item, lane, lanes }) => {
                const start = minutesInDay(item.startsAt, column.day);
                const end = minutesInDay(item.endsAt, column.day);
                const meta = statusMeta(item.status);
                const color = item.stylistColor ?? 'var(--primary)';
                const tall = px(end - start) >= 44;
                return (
                  <button
                    key={item.id}
                    type="button"
                    draggable={
                      canDrag && (item.status === 'SCHEDULED' || item.status === 'CONFIRMED')
                    }
                    onDragStart={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      const offset = ((event.clientY - box.top) / HOUR_HEIGHT) * 60;
                      event.dataTransfer.setData('text/plain', item.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging({ appointment: item, offset });
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setGhost(null);
                    }}
                    onClick={() => onSelect(item)}
                    aria-label={`${time(item.startsAt)} ${item.clientName ?? 'Clienta'}, ${meta.label}`}
                    className={cn(
                      'absolute z-[1] overflow-hidden rounded-lg border-l-4 px-1.5 py-1 text-left text-xs shadow-sm transition hover:z-[2] hover:shadow-md focus-visible:z-[2]',
                      meta.block,
                      dragging?.appointment.id === item.id && 'opacity-40',
                    )}
                    style={{
                      top: px(start - range.start) + 1,
                      height: Math.max(px(end - start) - 2, 22),
                      left: `calc(${(lane / lanes) * 100}% + 2px)`,
                      width: `calc(${100 / lanes}% - 4px)`,
                      borderLeftColor: color,
                      background: `color-mix(in oklch, ${color} 16%, var(--card))`,
                    }}
                  >
                    <span className="flex items-center gap-1 font-semibold tabular-nums">
                      <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} />
                      {shortTime(item.startsAt)}
                      {item.pendingChange && (
                        <CalendarClock
                          size={12}
                          className="shrink-0 text-warning"
                          aria-label="Cambio pedido"
                        />
                      )}
                      {item.lastReminder?.status === 'SENT' && (
                        <BellRing
                          size={11}
                          className="shrink-0 text-success"
                          aria-label="Recordada"
                        />
                      )}
                      {item.internalNotes && <StickyNote size={11} className="shrink-0" />}
                    </span>
                    <span className="block truncate font-medium">
                      {item.clientName ?? 'Clienta'}
                    </span>
                    {tall && (
                      <span className="block truncate text-muted-foreground">
                        {item.services
                          .map((line) => line.name)
                          .filter(Boolean)
                          .join(' · ') || item.stylistName}
                      </span>
                    )}
                  </button>
                );
              })}

              {ghost?.column === column.key && dragging && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-1 z-[3] rounded-lg border-2 border-dashed border-primary bg-primary/10 px-2 text-xs font-semibold text-primary"
                  style={{
                    top: px(ghost.minutes - range.start),
                    height: px(dragging.appointment.durationMinutes),
                  }}
                >
                  {time(atMinutes(column.day, ghost.minutes))}
                </div>
              )}

              {isToday && nowMinutes >= range.start && nowMinutes <= range.end && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 z-[4] border-t-2 border-danger"
                  style={{ top: px(nowMinutes - range.start) }}
                >
                  <span className="absolute -top-1.5 -left-1 size-3 rounded-full bg-danger" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
