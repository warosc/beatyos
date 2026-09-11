import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CLOCK, type Clock, type UseCase } from '../../../shared/application/ports';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import type { Env } from '../../../shared/infrastructure/config/env.schema';
import {
  GetCurrentCashSessionUseCase,
  type CashSessionView,
} from '../../cash/application/cash.use-cases';
import {
  appointmentCounts,
  dailySales,
  occupancy,
  resolvePeriod,
  retentionRate,
  stylistPerformance,
  summarizeSales,
  topProducts,
  type DateRange,
  type OccupancyResult,
  type RankedItem,
  type StylistPerformance,
  type UpcomingAppointmentFact,
} from '../domain/reporting';
import { REPORTING_REPOSITORY, type ReportingRepository } from '../domain/reporting.repository';

export interface ExecutiveReport {
  readonly period: DateRange;
  readonly timeZone: string;
  readonly currency: string;
  readonly sales: Money;
  readonly tickets: number;
  readonly averageTicket: Money;
  readonly retentionRate: number;
  readonly occupancy: OccupancyResult;
  readonly appointments: Record<string, number>;
  readonly topProducts: readonly RankedItem[];
  readonly topStylists: readonly StylistPerformance[];
  readonly dailySales: readonly { date: string; total: Money }[];
  readonly commissionTotal: Money;
}

export interface ExecutiveReportInput {
  readonly from?: string | null;
  readonly to?: string | null;
  /**
   * Ventana por defecto cuando no se indican fechas.
   *
   * El informe ejecutivo mira el ultimo mes y el panel del dia solo hoy. Es el unico
   * parametro que los distingue, asi que se pasa en lugar de duplicar el caso de uso.
   */
  readonly fallbackDays?: number;
}

/**
 * Informe ejecutivo (ADR-0015).
 *
 * Lanza las cuatro consultas en paralelo porque son independientes: hacerlas en serie
 * multiplica por cuatro la latencia de la pantalla que más se mira, sin ganar nada.
 *
 * Todos los cálculos viven en el dominio, que son funciones puras. Aquí solo se resuelve el
 * periodo, se piden los hechos y se compone la respuesta.
 */
@Injectable()
export class GetExecutiveReportUseCase implements UseCase<ExecutiveReportInput, ExecutiveReport> {
  private readonly currency: string;
  private readonly timeZone: string;

  constructor(
    @Inject(REPORTING_REPOSITORY) private readonly reporting: ReportingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
    this.timeZone = config.get('DEFAULT_TIMEZONE', { infer: true });
  }

  async execute(input: ExecutiveReportInput): Promise<ExecutiveReport> {
    const period = resolvePeriod({
      from: input.from,
      to: input.to,
      fallbackDays: input.fallbackDays ?? 30,
      now: this.clock.now(),
    });

    const [sales, lines, appointments, schedules] = await Promise.all([
      this.reporting.findSales(period),
      this.reporting.findSaleLines(period),
      this.reporting.findAppointments(period),
      this.reporting.findSchedules(),
    ]);

    const summary = summarizeSales(sales, this.currency);
    // El reporte ejecutivo es donde se consulta cuánto se le debe a cada profesional, no un
    // "top 5" de escaparate: el límite por defecto (pensado para el panel del dashboard) se
    // sube aquí para que nadie del equipo quede fuera de la lista.
    const stylists = stylistPerformance(lines, this.currency, 50);

    return {
      period,
      timeZone: this.timeZone,
      currency: this.currency,
      sales: summary.total,
      tickets: summary.tickets,
      averageTicket: summary.averageTicket,
      retentionRate: retentionRate(sales),
      occupancy: occupancy(appointments, schedules, period, this.timeZone),
      appointments: appointmentCounts(appointments),
      topProducts: topProducts(lines, this.currency),
      topStylists: stylists,
      // Las comisiones se agregan sobre **todas** las líneas, no sobre el top de
      // profesionales: si no, el pasivo del mes cambiaría según cuántos se muestren.
      dailySales: dailySales(sales, period, this.timeZone, this.currency),
      commissionTotal: Money.sum(
        lines.map((line) => line.commissionAmount),
        this.currency,
      ),
    };
  }
}

// ---------------------------------------------------------------------------

/** Citas que caben en el panel sin obligar a desplazarse. */
const UPCOMING_LIMIT = 5;

export interface DashboardReport extends ExecutiveReport {
  readonly lowStockCount: number;
  readonly cash: CashSessionView | null;
  readonly upcoming: readonly UpcomingAppointmentFact[];
}

/**
 * Panel del día.
 *
 * Es el informe ejecutivo del día en curso más lo que hay que mirar ahora: cuántos productos
 * hay que reponer y cómo va la caja.
 *
 * **No recalcula el efectivo esperado.** Lo pide a `GetCurrentCashSessionUseCase`, que pasa
 * por `CashSession.expectedAmount`. La versión anterior lo calculaba aquí con su propia
 * fórmula —la tercera copia de la misma cuenta en el sistema—, y bastaba con que una de las
 * tres olvidara un tipo de movimiento para que el panel y el arqueo dieran cifras distintas
 * sin que nadie supiera cuál creer (ADR-0002).
 */
@Injectable()
export class GetDashboardUseCase implements UseCase<ExecutiveReportInput, DashboardReport> {
  constructor(
    private readonly executive: GetExecutiveReportUseCase,
    @Inject(REPORTING_REPOSITORY) private readonly reporting: ReportingRepository,
    private readonly currentCash: GetCurrentCashSessionUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ExecutiveReportInput): Promise<DashboardReport> {
    const [report, lowStockCount, cash, upcoming] = await Promise.all([
      this.executive.execute({ from: input.from, to: input.to, fallbackDays: 1 }),
      this.reporting.countProductsBelowReorderPoint(),
      this.currentCash.execute(),
      // Desde ahora, no desde el inicio del periodo: el panel mira hacia delante.
      this.reporting.findUpcomingAppointments(this.clock.now(), UPCOMING_LIMIT),
    ]);

    return { ...report, lowStockCount, cash, upcoming };
  }
}
