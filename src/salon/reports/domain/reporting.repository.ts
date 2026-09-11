import type {
  AppointmentFact,
  DateRange,
  SaleFact,
  SaleLineFact,
  ScheduleFact,
  UpcomingAppointmentFact,
} from './reporting';

/**
 * Puerto de lectura para informes (ADR-0015).
 *
 * Devuelve **hechos**, no filas: `SaleFact` y `SaleLineFact` son lo mínimo que un indicador
 * necesita, con el dinero ya en `Money`. El adaptador se queda con la tarea de traducir, y
 * el cálculo no vuelve a ver un `Decimal` de Prisma ni un `include` anidado.
 *
 * Es un puerto aparte de los repositorios de cada módulo porque su forma la dicta la
 * pregunta —«cuánto se ha vendido este mes»— y no el agregado. Reutilizar
 * `InvoiceRepository.search` obligaría a paginar y a rehidratar facturas completas con sus
 * líneas para acabar sumando un campo de cada una.
 */
export interface ReportingRepository {
  /** Ventas cobradas del periodo. Excluye anuladas y borradas. */
  findSales(range: DateRange): Promise<SaleFact[]>;

  /** Líneas de esas ventas, con el nombre del profesional ya resuelto. */
  findSaleLines(range: DateRange): Promise<SaleLineFact[]>;

  findAppointments(range: DateRange): Promise<AppointmentFact[]>;

  /** Horarios vigentes de los profesionales. Es el denominador de la ocupación. */
  findSchedules(): Promise<ScheduleFact[]>;

  /** Cuántos productos activos están en o por debajo de su punto de pedido. */
  countProductsBelowReorderPoint(): Promise<number>;

  /**
   * Próximas citas todavía por atender.
   *
   * Va aparte del periodo del informe a propósito: el panel mira **hacia delante** —qué
   * viene ahora— mientras que los indicadores miran hacia atrás. Meterlas en el rango del
   * informe haría que al consultar el mes pasado apareciesen como «próximas» unas citas que
   * ya ocurrieron.
   */
  findUpcomingAppointments(from: Date, limit: number): Promise<UpcomingAppointmentFact[]>;
}

export const REPORTING_REPOSITORY = Symbol('ReportingRepository');
