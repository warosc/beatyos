import { DomainValidationError } from '../../../shared/domain/errors';
import {
  addCalendarDays,
  dayOfWeekInZone,
  formatCalendarDay,
  instantToCalendarDay,
  zonedTimeToInstant,
  type CalendarDay,
} from '../../../shared/domain/time/zoned-time';
import { Money } from '../../../shared/domain/value-objects/money.vo';

/**
 * Cálculo de indicadores (ADR-0015).
 *
 * Son funciones puras: entran hechos, sale un informe. Ninguna toca la base de datos, y por
 * eso se pueden probar con datos escritos a mano en lugar de sembrar un año de ventas.
 *
 * El detalle que más se subestima aquí es **la zona horaria**. Un informe agrupa por días, y
 * un día es un concepto local: en Guatemala (UTC−6) una venta de las 19:00 del día 5 ocurre
 * a las 01:00 UTC del día 6. Agrupar por la fecha UTC manda al día siguiente casi todas las
 * ventas de la tarde —que en un salón son buena parte del total— y produce un gráfico en el
 * que los lunes parecen flojos porque el domingo se ha comido su facturación.
 */

/** Una venta, reducida a lo que un informe necesita. */
export interface SaleFact {
  readonly invoiceId: string;
  readonly clientId: string | null;
  readonly total: Money;
  readonly issuedAt: Date;
}

/** Una línea vendida, reducida a lo que un informe necesita. */
export interface SaleLineFact {
  readonly kind: 'SERVICE' | 'PRODUCT' | 'DISCOUNT' | 'OTHER';
  readonly productId: string | null;
  readonly serviceId: string | null;
  readonly stylistId: string | null;
  readonly stylistName: string | null;
  readonly description: string;
  readonly quantity: number;
  /** Base imponible de la linea. Sin IVA (ADR-0027) coincide con `lineTotal`. */
  readonly lineSubtotal: Money;
  /** Lo que paga la clienta, despues de descuentos: la base de la comision. */
  readonly lineTotal: Money;
  readonly commissionAmount: Money;
}

export interface AppointmentFact {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  readonly isBlocking: boolean;
}

/**
 * Proxima cita, con los nombres ya resueltos.
 *
 * El panel la pinta tal cual: hora, clienta, profesional y servicios. Se resuelve en la
 * consulta porque pedir cada nombre por separado serian tres viajes por cita, y son las
 * cinco primeras filas de la pantalla que mas se abre.
 */
export interface UpcomingAppointmentFact {
  readonly id: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: string;
  readonly clientName: string;
  readonly stylistName: string;
  readonly stylistColor: string | null;
  readonly serviceNames: readonly string[];
}

export interface ScheduleFact {
  /** 0 = domingo, como en `Date.getDay()`. */
  readonly dayOfWeek: number;
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/** Estados que no ocupan sillón: no cuentan ni como trabajo hecho ni como hueco vendido. */
const NON_OCCUPYING: ReadonlySet<string> = new Set(['CANCELLED', 'NO_SHOW']);

const MAX_RANGE_DAYS = 366;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------

/**
 * Resuelve el periodo del informe.
 *
 * El tope de 366 días no es arbitrario: un informe abierto sin límite acaba pidiendo el
 * histórico entero, y esa consulta tumba la base en el momento en que alguien la lanza
 * desde el móvil un sábado. Un año más un día cubre cualquier comparativa interanual.
 */
export const resolvePeriod = (params: {
  from?: string | null;
  to?: string | null;
  fallbackDays: number;
  now: Date;
}): DateRange => {
  const to = params.to ? new Date(params.to) : params.now;
  const from = params.from
    ? new Date(params.from)
    : new Date(to.getTime() - params.fallbackDays * MS_PER_DAY);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new DomainValidationError('Las fechas del informe no son válidas', 'period');
  }
  if (from >= to) {
    throw new DomainValidationError('La fecha inicial debe ser anterior a la final', 'period');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * MS_PER_DAY) {
    throw new DomainValidationError(
      `El rango máximo de un informe es de ${MAX_RANGE_DAYS} días`,
      'period',
    );
  }

  return { from, to };
};

// ---------------------------------------------------------------------------

export interface SalesSummary {
  readonly total: Money;
  readonly tickets: number;
  readonly averageTicket: Money;
}

export const summarizeSales = (sales: readonly SaleFact[], currency: string): SalesSummary => {
  const total = Money.sum(
    sales.map((sale) => sale.total),
    currency,
  );

  return {
    total,
    tickets: sales.length,
    // Sin ventas el ticket medio es cero, no `NaN`: una división por cero que se cuela hasta
    // la interfaz se pinta como «NaN €» y quien lo ve piensa que el sistema está roto.
    averageTicket: sales.length
      ? Money.fromMinorUnits(Math.round(total.minorUnits / sales.length), currency)
      : Money.zero(currency),
  };
};

/**
 * Facturación por día **en la hora del salón**.
 *
 * Es donde vivía el fallo de la versión anterior: agrupaba por `issuedAt.toISOString()`, que
 * es UTC. Con el salón en UTC−6, toda venta posterior a las 18:00 locales se contabilizaba
 * en el día siguiente.
 *
 * Devuelve la serie **completa**, con los días sin ventas a cero. Omitirlos haría que un
 * gráfico de líneas uniera el lunes con el jueves en línea recta y aparentara una caída
 * suave donde hubo tres días cerrados.
 */
export const dailySales = (
  sales: readonly SaleFact[],
  range: DateRange,
  timeZone: string,
  currency: string,
): { date: string; total: Money }[] => {
  const totals = new Map<string, Money>();

  for (const sale of sales) {
    const key = formatCalendarDay(instantToCalendarDay(sale.issuedAt, timeZone));
    totals.set(key, (totals.get(key) ?? Money.zero(currency)).add(sale.total));
  }

  const series: { date: string; total: Money }[] = [];
  let day = instantToCalendarDay(range.from, timeZone);
  const lastDay = formatCalendarDay(
    instantToCalendarDay(new Date(range.to.getTime() - 1), timeZone),
  );

  // Se recorre por días de calendario y no sumando 24 horas: en un cambio de hora un día
  // dura 23 o 25, y avanzar en milisegundos acabaría saltándose una jornada o repitiéndola.
  for (let guard = 0; guard <= MAX_RANGE_DAYS; guard += 1) {
    const key = formatCalendarDay(day);
    series.push({ date: key, total: totals.get(key) ?? Money.zero(currency) });
    if (key === lastDay) break;
    day = addCalendarDays(day, 1);
  }

  return series;
};

// ---------------------------------------------------------------------------

export interface RankedItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly revenue: Money;
}

/** Productos más vendidos, por unidades. */
export const topProducts = (
  lines: readonly SaleLineFact[],
  currency: string,
  limit = 5,
): RankedItem[] => {
  const byProduct = new Map<string, { name: string; quantity: number; revenue: Money }>();

  for (const line of lines) {
    if (line.kind !== 'PRODUCT' || !line.productId) continue;

    const current = byProduct.get(line.productId) ?? {
      name: line.description,
      quantity: 0,
      revenue: Money.zero(currency),
    };

    byProduct.set(line.productId, {
      name: current.name,
      quantity: round3(current.quantity + line.quantity),
      revenue: current.revenue.add(line.lineTotal),
    });
  }

  return (
    [...byProduct.entries()]
      .map(([id, item]) => ({ id, ...item }))
      // El desempate por nombre hace el orden determinista: sin él, dos productos con las
      // mismas ventas bailarían de posición entre recargas sin que nada haya cambiado.
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
      .slice(0, limit)
  );
};

export interface StylistPerformance {
  readonly id: string;
  readonly name: string;
  /** Lo que pagaron las clientas por sus servicios. */
  readonly revenue: Money;
  readonly services: number;
  readonly serviceCommission: Money;
  /** Lo que pagaron las clientas por los productos cobrados a su nombre. */
  readonly productRevenue: Money;
  /** Unidades de producto cobradas a su nombre. */
  readonly products: number;
  readonly productCommission: Money;
}

/**
 * Rendimiento por profesional.
 *
 * Servicios y productos se cuentan **por separado** y nunca se suman (ADR-0027): son dos
 * comisiones distintas, con su propio porcentaje, y la dueña paga mirando cada una.
 * `revenue` y `services` son solo trabajo de servicio, que es por lo que se ordena la lista;
 * un producto cobrado a su nombre va a `productRevenue`, `products` y `productCommission`.
 * Las comisiones salen de la línea, donde se congelaron al facturar.
 *
 * Lo facturado es lo que pagó la clienta, después de descuentos: la misma base sobre la que
 * se calcula la comisión, así el porcentaje aparente coincide con el pactado.
 */
export const stylistPerformance = (
  lines: readonly SaleLineFact[],
  currency: string,
  limit = 5,
): StylistPerformance[] => {
  const byStylist = new Map<string, Omit<StylistPerformance, 'id'>>();

  for (const line of lines) {
    if (!line.stylistId) continue;
    if (line.kind !== 'SERVICE' && line.kind !== 'PRODUCT') continue;

    const current = byStylist.get(line.stylistId) ?? {
      name: line.stylistName ?? 'Sin nombre',
      revenue: Money.zero(currency),
      services: 0,
      serviceCommission: Money.zero(currency),
      productRevenue: Money.zero(currency),
      products: 0,
      productCommission: Money.zero(currency),
    };

    byStylist.set(
      line.stylistId,
      line.kind === 'SERVICE'
        ? {
            ...current,
            revenue: current.revenue.add(line.lineTotal),
            services: round3(current.services + line.quantity),
            serviceCommission: current.serviceCommission.add(line.commissionAmount),
          }
        : {
            ...current,
            productRevenue: current.productRevenue.add(line.lineTotal),
            products: round3(current.products + line.quantity),
            productCommission: current.productCommission.add(line.commissionAmount),
          },
    );
  }

  return [...byStylist.entries()]
    .map(([id, item]) => ({ id, ...item }))
    .sort((a, b) => b.revenue.minorUnits - a.revenue.minorUnits || a.name.localeCompare(b.name))
    .slice(0, limit);
};

// ---------------------------------------------------------------------------

/**
 * Porcentaje de clientas que han vuelto dentro del periodo.
 *
 * Es una medida **del periodo**, no del histórico: dice cuántas de las que compraron
 * volvieron a comprar dentro de la ventana consultada. En una semana dará casi siempre bajo
 * y en un año, alto; compararlos entre sí no significa nada, y por eso el informe devuelve
 * también el periodo al que se refiere.
 *
 * Las ventas sin clienta identificada no cuentan: no se puede saber si esa persona volvió.
 */
export const retentionRate = (sales: readonly SaleFact[]): number => {
  const visitsByClient = new Map<string, number>();

  for (const sale of sales) {
    if (!sale.clientId) continue;
    visitsByClient.set(sale.clientId, (visitsByClient.get(sale.clientId) ?? 0) + 1);
  }

  if (visitsByClient.size === 0) return 0;

  const returning = [...visitsByClient.values()].filter((visits) => visits > 1).length;
  return round1((returning / visitsByClient.size) * 100);
};

// ---------------------------------------------------------------------------

export interface OccupancyResult {
  readonly bookedMinutes: number;
  readonly capacityMinutes: number;
  readonly rate: number;
}

/**
 * Ocupación: minutos vendidos sobre minutos disponibles.
 *
 * La capacidad se calcula recorriendo los días del periodo y sumando el horario de cada
 * profesional para ese día de la semana **en la zona del salón**. La versión anterior usaba
 * `getUTCDay()`, que con el salón en UTC−6 desplaza el día de la semana en las horas de
 * madrugada y asigna a un lunes el horario del domingo.
 *
 * Se recorta al 100 %: un solapamiento heredado o una cita fuera de horario pueden dar 103 %,
 * y una ocupación superior al total es una cifra que nadie sabe interpretar.
 */
export const occupancy = (
  appointments: readonly AppointmentFact[],
  schedules: readonly ScheduleFact[],
  range: DateRange,
  timeZone: string,
): OccupancyResult => {
  const bookedMinutes = appointments
    .filter((item) => !NON_OCCUPYING.has(item.status))
    .reduce((total, item) => total + (item.endsAt.getTime() - item.startsAt.getTime()) / 60_000, 0);

  let capacityMinutes = 0;
  let day: CalendarDay = instantToCalendarDay(range.from, timeZone);

  for (let guard = 0; guard <= MAX_RANGE_DAYS; guard += 1) {
    const dayStart = zonedTimeToInstant(day, 0, timeZone);
    if (dayStart.getTime() >= range.to.getTime()) break;

    const weekday = dayOfWeekInZone(dayStart, timeZone);
    capacityMinutes += schedules
      .filter((schedule) => schedule.dayOfWeek === weekday)
      .reduce((total, schedule) => total + (schedule.endMinutes - schedule.startMinutes), 0);

    day = addCalendarDays(day, 1);
  }

  return {
    bookedMinutes: Math.round(bookedMinutes),
    capacityMinutes,
    rate: capacityMinutes > 0 ? round1(Math.min(100, (bookedMinutes / capacityMinutes) * 100)) : 0,
  };
};

/** Recuento de citas por estado. Alimenta las tarjetas del panel. */
export const appointmentCounts = (
  appointments: readonly AppointmentFact[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const appointment of appointments) {
    counts[appointment.status] = (counts[appointment.status] ?? 0) + 1;
  }
  return counts;
};

// ---------------------------------------------------------------------------

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
