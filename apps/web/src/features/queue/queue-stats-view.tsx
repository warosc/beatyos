'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clock, Lightbulb, LogOut, Scissors, UsersRound, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useAccess } from '@/components/session-access';
import { Card } from '@/components/ui/card';
import { EmptyState, LoadError } from '@/components/ui/states';
import { ValueSkeleton } from '@/features/reports/executive-report';
import { localDay } from '@/lib/dates';
import { cn, currency } from '@/lib/utils';
import {
  fetchQueueStats,
  hourLabel,
  hourParts,
  insightText,
  WEEKDAYS,
  type QueueStats,
} from './stats';
import { minutesLabel } from './types';

/**
 * Colores de los gráficos (ADR-0025).
 *
 * Forma de énfasis: lo que se pierde, en el rojo de estado —significa «mal»—, y el resto en
 * un gris que no compite. Gris y rojo se separan también para el daltonismo (validado: ΔE
 * 21,7 en claro y 10,8 en oscuro); el gris queda por debajo de 3:1 sobre la tarjeta, así que
 * cada gráfico lleva sus cifras en la tabla de debajo. Una sola serie va en la tinta de la
 * marca del salón, que sí pasa 3:1 en los cuatro temas.
 */
const TONE = {
  rest: 'bg-[oklch(0.8_0.01_60)] dark:bg-[oklch(0.42_0.012_50)]',
  lost: 'bg-danger',
  accent: 'bg-[var(--primary-ink)]',
} as const;
type Tone = keyof typeof TONE;

const PRESETS = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

const daysAgo = (days: number) => localDay(new Date(Date.now() - days * 86_400_000));
const shortDate = (date: string) =>
  // Mediodía para que ningún huso horario lo pase al día anterior.
  new Date(`${date}T12:00:00`).toLocaleDateString('es-GT', { day: 'numeric', month: 'short' });

/**
 * Cifras de la fila para decidir (ADR-0025): cuánto esperan las clientas sin cita, cuántas
 * se van, a qué horas y qué días hace falta más gente, quién las atiende y cuánto dejan.
 */
export function QueueStatsView() {
  const { can } = useAccess();
  const [range, setRange] = useState(() => ({ from: daysAgo(29), to: localDay() }));
  const stats = useQuery({
    queryKey: ['queue', 'stats', range.from, range.to],
    enabled: can('reports.read'),
    // Al cambiar de periodo se queda lo anterior, atenuado, en vez de parpadear.
    placeholderData: (previous) => previous,
    queryFn: () => fetchQueueStats(range.from, range.to),
  });
  const data = stats.data;

  if (!can('reports.read')) {
    return (
      <p role="alert" className="p-8 text-center text-sm text-muted-foreground">
        Estas cifras son para quien ve los informes del salón.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <Link
          href="/turnos"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          Fila de espera
        </Link>
        <h1 className="font-display text-4xl font-semibold">Estadísticas de la fila</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Clientas sin cita: cuánto esperan, cuántas se van y a qué horas hace falta más gente.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <div role="group" aria-label="Periodo" className="flex rounded-xl bg-muted p-1">
          {PRESETS.map((preset) => {
            const active = range.to === localDay() && range.from === daysAgo(preset.days - 1);
            return (
              <button
                key={preset.days}
                type="button"
                aria-pressed={active}
                onClick={() => setRange({ from: daysAgo(preset.days - 1), to: localDay() })}
                className={cn(
                  'min-h-10 rounded-lg px-4 text-sm font-semibold',
                  active ? 'bg-card shadow-sm' : 'text-muted-foreground',
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <DateField
          label="Desde"
          value={range.from}
          onChange={(from) => setRange((r) => ({ ...r, from }))}
        />
        <DateField
          label="Hasta"
          value={range.to}
          onChange={(to) => setRange((r) => ({ ...r, to }))}
        />
      </div>

      {stats.isError && (
        <LoadError message={stats.error.message} onRetry={() => void stats.refetch()} />
      )}

      <div className={cn('space-y-6 transition-opacity', stats.isFetching && data && 'opacity-60')}>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
          <Kpi
            icon={UsersRound}
            label="Llegaron sin cita"
            value={data?.arrivals.toLocaleString('es-GT')}
          >
            {data &&
              `${data.attended} atendidas${data.pending ? ` · ${data.pending} en curso` : ''}`}
          </Kpi>
          <Kpi
            icon={LogOut}
            label="Se perdieron"
            value={data && (data.abandonmentRate === null ? '—' : `${data.abandonmentRate} %`)}
          >
            {data &&
              `${data.left} se fueron · ${data.noShow} no vinieron · ${data.unattended} sin atender al cierre`}
          </Kpi>
          <Kpi
            icon={Clock}
            label="Espera media"
            value={data && (data.wait.average === null ? '—' : minutesLabel(data.wait.average))}
          >
            {data?.wait.p90 != null &&
              `9 de cada 10 esperan ${minutesLabel(data.wait.p90)} o menos`}
          </Kpi>
          <Kpi
            icon={Scissors}
            label="Tiempo de sillón"
            value={
              data && (data.service.average === null ? '—' : minutesLabel(data.service.average))
            }
          >
            {data && `De media, por clienta atendida`}
          </Kpi>
          <Kpi
            icon={Wallet}
            label="Cobrado a la fila"
            value={data && currency.format(Number(data.revenue))}
          >
            {data && `${data.chargedTurns} ${data.chargedTurns === 1 ? 'comanda' : 'comandas'}`}
          </Kpi>
        </div>

        {data && data.arrivals === 0 ? (
          <EmptyState
            title="Ninguna clienta sin cita en este periodo"
            hint="Las cifras aparecen en cuanto recepción anote a alguien en la fila."
          />
        ) : (
          data && <Details data={data} />
        )}
      </div>
    </div>
  );
}

function Details({ data }: { data: QueueStats }) {
  const legend = (
    <Legend
      items={[
        { tone: 'rest', label: 'Atendidas o en curso' },
        { tone: 'lost', label: 'Se perdieron' },
      ]}
    />
  );
  // La semana empieza el lunes, como se piensa en el salón.
  const week = [1, 2, 3, 4, 5, 6, 0].map((weekday) =>
    data.byWeekday.find((day) => day.weekday === weekday)!,
  );
  const maxPerDay = Math.max(1, ...week.map((day) => day.arrivalsPerDay));
  const maxRequests = Math.max(1, ...data.byService.map((service) => service.requests));

  return (
    <>
      {data.insights.length > 0 && (
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
            <Lightbulb size={20} className="text-primary" />
            Lo que dicen los datos
          </h2>
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {data.insights.map((insight) => {
              const text = insightText(insight);
              return (
                <li key={insight.kind} className="rounded-xl bg-muted p-4">
                  <p className="font-semibold">{text.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{text.hint}</p>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard
          title="Llegadas por hora"
          subtitle="A qué hora entran las clientas sin cita y cuántas se pierden."
          legend={legend}
          table={{
            head: ['Hora', 'Llegaron', 'Se perdieron', 'Espera media'],
            rows: data.byHour.map((hour) => [
              hourLabel(hour.hour),
              hour.arrivals,
              hour.abandoned,
              hour.averageWait === null ? '—' : minutesLabel(hour.averageWait),
            ]),
          }}
        >
          <ColumnChart
            label="Llegadas por hora"
            columns={data.byHour.map((hour) => ({
              key: String(hour.hour),
              axis: hourLabel(hour.hour),
              tick: <HourTick hour={hour.hour} />,
              cap: hour.arrivals ? String(hour.arrivals) : '',
              segments: [
                { tone: 'rest', value: hour.arrivals - hour.abandoned },
                { tone: 'lost', value: hour.abandoned },
              ],
              detail: [
                `${hour.arrivals} llegaron`,
                `${hour.abandoned} se perdieron`,
                hour.averageWait === null
                  ? 'sin llamadas'
                  : `esperaron ${minutesLabel(hour.averageWait)}`,
              ],
            }))}
          />
        </ChartCard>

        <ChartCard
          title="Espera media por hora de llegada"
          subtitle="De la llegada a la primera llamada. Las horas en blanco no tuvieron llamadas."
          table={{
            head: ['Hora', 'Espera media'],
            rows: data.byHour.map((hour) => [
              hourLabel(hour.hour),
              hour.averageWait === null ? '—' : minutesLabel(hour.averageWait),
            ]),
          }}
        >
          <ColumnChart
            label="Espera media por hora"
            columns={data.byHour.map((hour) => ({
              key: String(hour.hour),
              axis: hourLabel(hour.hour),
              tick: <HourTick hour={hour.hour} />,
              cap: hour.averageWait === null ? '' : minutesLabel(hour.averageWait),
              segments: [{ tone: 'accent', value: hour.averageWait ?? 0 }],
              detail: [
                hour.averageWait === null
                  ? 'sin llamadas'
                  : `esperaron ${minutesLabel(hour.averageWait)} de media`,
              ],
            }))}
          />
        </ChartCard>
      </div>

      <ChartCard
        title="Día a día"
        subtitle="Clientas sin cita de cada día del periodo."
        legend={legend}
        table={{
          head: ['Día', 'Llegaron', 'Atendidas', 'Se perdieron', 'Espera media'],
          rows: data.byDay.map((day) => [
            shortDate(day.date),
            day.arrivals,
            day.attended,
            day.abandoned,
            day.averageWait === null ? '—' : minutesLabel(day.averageWait),
          ]),
        }}
      >
        <ColumnChart
          label="Clientas sin cita por día"
          // Con muchos días, una etiqueta cada semana: más no se leen.
          axisEvery={data.byDay.length > 31 ? 7 : data.byDay.length > 14 ? 2 : 1}
          scrollToEnd
          columns={data.byDay.map((day) => ({
            key: day.date,
            axis: shortDate(day.date),
            cap: '',
            segments: [
              { tone: 'rest', value: day.arrivals - day.abandoned },
              { tone: 'lost', value: day.abandoned },
            ],
            detail: [
              `${day.arrivals} llegaron`,
              `${day.attended} atendidas`,
              `${day.abandoned} se perdieron`,
            ],
          }))}
        />
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-display text-xl font-semibold">Por día de la semana</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Llegadas de media cada uno de esos días del periodo.
          </p>
          <ul className="mt-5 space-y-3">
            {week.map((day) => (
              <BarRow
                key={day.weekday}
                label={WEEKDAYS[day.weekday]!}
                value={day.arrivalsPerDay}
                max={maxPerDay}
                valueLabel={day.arrivalsPerDay.toLocaleString('es-GT')}
                detail={
                  day.averageWait === null ? undefined : `espera ${minutesLabel(day.averageWait)}`
                }
              />
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-xl font-semibold">Lo que más piden al llegar</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Servicios anotados en la fila. Una clienta puede pedir varios.
          </p>
          {data.byService.length ? (
            <ul className="mt-5 space-y-3">
              {data.byService.slice(0, 8).map((service) => (
                <BarRow
                  key={service.serviceId}
                  label={service.name}
                  value={service.requests}
                  max={maxRequests}
                  valueLabel={String(service.requests)}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-5 text-sm text-muted-foreground">
              Recepción no anotó servicios en este periodo.
            </p>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden">
        <h2 className="border-b p-5 font-display text-xl font-semibold">Profesionales</h2>
        {data.byStylist.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-semibold">Profesional</th>
                  <th className="px-5 py-3 text-right font-semibold">Atendidas</th>
                  <th className="px-5 py-3 text-right font-semibold">La pidieron</th>
                  <th className="px-5 py-3 text-right font-semibold">Sillón medio</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.byStylist.map((stylist) => (
                  <tr key={stylist.stylistId}>
                    <td className="px-5 py-3 font-semibold">{stylist.name}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{stylist.attended}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{stylist.requested}</td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {stylist.averageService === null ? '—' : minutesLabel(stylist.averageService)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">Nadie atendió desde la fila aún.</p>
        )}
      </Card>

      {data.waitBeforeLeaving.samples > 0 && (
        <p className="text-sm text-muted-foreground">
          Las {data.waitBeforeLeaving.samples} que se fueron sin que las llamaran esperaron{' '}
          {minutesLabel(data.waitBeforeLeaving.average!)} de media antes de irse.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-semibold text-muted-foreground">
      {label}
      <input
        type="date"
        value={value}
        max={localDay()}
        onChange={(event) => event.target.value && onChange(event.target.value)}
        className="mt-1 block h-11 rounded-xl border bg-card px-3 text-sm text-foreground"
      />
    </label>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: typeof Clock;
  label: string;
  value: string | undefined;
  children?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon size={16} />
        {label}
      </p>
      <p className="mt-3 text-3xl font-bold">{value ?? <ValueSkeleton />}</p>
      {children && <p className="mt-2 text-xs text-muted-foreground">{children}</p>}
    </Card>
  );
}

function ChartCard({
  title,
  subtitle,
  legend,
  table,
  children,
}: {
  title: string;
  subtitle: string;
  legend?: ReactNode;
  table: { head: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {legend}
      </div>
      <div className="mt-5">{children}</div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Ver como tabla</summary>
        <div className="mt-3 max-h-72 overflow-auto">
          <table className="w-full">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                {table.head.map((cell, index) => (
                  <th key={cell} className={cn('py-2 font-semibold', index > 0 && 'text-right')}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {table.rows.map((row) => (
                <tr key={String(row[0])}>
                  {row.map((cell, index) => (
                    <td key={index} className={cn('py-2', index > 0 && 'text-right tabular-nums')}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

function Legend({ items }: { items: { tone: Tone; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.tone} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-3 rounded-sm', TONE[item.tone])} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

interface Column {
  key: string;
  /** Nombre completo de la columna: tooltip, lector de pantalla y tabla. */
  axis: string;
  /** Etiqueta corta del eje, si el nombre completo no cabe bajo una columna. */
  tick?: ReactNode;
  /** Cifra sobre la columna; vacía para no poner un número en cada una. */
  cap: string;
  segments: { tone: Tone; value: number }[];
  /** Líneas del tooltip, de la cifra al detalle. */
  detail: string[];
}

const PLOT_HEIGHT = 160;

/**
 * Columnas apiladas desde una sola línea base. Columnas finas (≤ 24 px) con el extremo
 * redondeado, 2 px de tarjeta entre segmentos y la columna entera como zona de puntero: al
 * pasar por encima o enfocarla con el teclado se ven sus cifras.
 */
function ColumnChart({
  label,
  columns,
  axisEvery = 1,
  scrollToEnd = false,
}: {
  label: string;
  columns: Column[];
  axisEvery?: number;
  /** Con más columnas de las que caben, empieza enseñando las últimas: lo reciente. */
  scrollToEnd?: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const tooltipId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollToEnd && scroller.current) {
      scroller.current.scrollLeft = scroller.current.scrollWidth;
    }
  }, [scrollToEnd, columns.length]);
  const max = Math.max(
    1,
    ...columns.map((column) => column.segments.reduce((sum, s) => sum + s.value, 0)),
  );

  return (
    <div ref={scroller} role="group" aria-label={label} className="overflow-x-auto">
      <div className="flex min-w-fit items-end gap-1 border-b" style={{ height: PLOT_HEIGHT + 24 }}>
        {columns.map((column, position) => {
          const total = column.segments.reduce((sum, s) => sum + s.value, 0);
          // El tooltip se queda dentro del gráfico —el desplazamiento lateral recorta lo que
          // sale—: arriba de la columna y, en los bordes, alineado hacia dentro.
          const side =
            position < columns.length / 3
              ? 'left-0'
              : position >= (columns.length * 2) / 3
                ? 'right-0'
                : 'left-1/2 -translate-x-1/2';
          const visible = column.segments.filter((segment) => segment.value > 0);
          const isActive = active === column.key;
          return (
            <div
              key={column.key}
              tabIndex={0}
              aria-describedby={isActive ? tooltipId : undefined}
              aria-label={`${column.axis}: ${column.detail.join(', ')}`}
              onPointerEnter={() => setActive(column.key)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(column.key)}
              onBlur={() => setActive(null)}
              className="relative flex h-full min-w-6 flex-1 flex-col items-center justify-end outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {column.cap && (
                <span className="mb-1 text-[11px] font-semibold text-muted-foreground tabular-nums">
                  {column.cap}
                </span>
              )}
              <div
                className={cn(
                  'flex w-full max-w-6 flex-col-reverse gap-[2px] transition',
                  isActive && 'brightness-110',
                )}
                style={{ height: (total / max) * PLOT_HEIGHT }}
              >
                {visible.map((segment, index) => (
                  <div
                    key={segment.tone}
                    className={cn(
                      TONE[segment.tone],
                      index === visible.length - 1 && 'rounded-t-[4px]',
                    )}
                    style={{ flexGrow: segment.value, minHeight: 2 }}
                  />
                ))}
              </div>
              {isActive && (
                <div
                  id={tooltipId}
                  role="tooltip"
                  className={cn(
                    'pointer-events-none absolute top-0 z-10 w-max max-w-48 rounded-lg border bg-card px-3 py-2 text-xs shadow-lg',
                    side,
                  )}
                >
                  <p className="font-semibold">{column.axis}</p>
                  {column.detail.map((line, index) => (
                    <p
                      key={line}
                      className={index === 0 ? 'text-sm font-bold' : 'text-muted-foreground'}
                    >
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex min-w-fit gap-1 pt-2">
        {columns.map((column, index) => (
          <span
            key={column.key}
            className="min-w-6 flex-1 text-center text-[10px] leading-tight whitespace-nowrap text-muted-foreground"
          >
            {index % axisEvery === 0 ? (column.tick ?? column.axis) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function BarRow({
  label,
  value,
  max,
  valueLabel,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  valueLabel: string;
  detail?: string;
}) {
  return (
    <li className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 text-sm">
      <span className="truncate first-letter:uppercase">{label}</span>
      <span className="h-5">
        <span
          className={cn('block h-full rounded-r-[4px]', TONE.accent)}
          style={{ width: `${Math.max(value > 0 ? 2 : 0, (value / max) * 100)}%` }}
        />
      </span>
      <span className="text-right tabular-nums">
        <strong>{valueLabel}</strong>
        {detail && <span className="ml-2 text-xs text-muted-foreground">{detail}</span>}
      </span>
    </li>
  );
}

/** La hora del eje en dos líneas, «9» sobre «a. m.»: en una sola no caben bajo la columna. */
function HourTick({ hour }: { hour: number }) {
  const { number, suffix } = hourParts(hour);
  return (
    <>
      <span className="block">{number}</span>
      <span className="block">{suffix}</span>
    </>
  );
}
