import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppointmentStatus, InvoiceStatus, Prisma } from '@prisma/client';

import { Money } from '../../../../shared/domain/value-objects/money.vo';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import type {
  AppointmentFact,
  DateRange,
  SaleFact,
  SaleLineFact,
  ScheduleFact,
  UpcomingAppointmentFact,
} from '../../domain/reporting';
import type { ReportingRepository } from '../../domain/reporting.repository';

/** Estados que cuentan como ingreso: lo cobrado es lo cobrado, aunque quede saldo. */
const PAID_STATUSES: InvoiceStatus[] = ['PAID', 'PARTIALLY_PAID'];

/** Citas que aun estan por atender. Una cancelada no es una proxima cita. */
const UPCOMING_STATUSES: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];

/**
 * Adaptador de lectura para informes (ADR-0015).
 *
 * Cada consulta pide **solo las columnas que el indicador usa**. Un `select` estrecho no es
 * microoptimización aquí: la consulta de un año de ventas con todas las líneas y sus
 * relaciones anidadas mueve megabytes por la red para acabar sumando dos campos de cada
 * fila, y esa es la pantalla que se abre nada más entrar al sistema.
 *
 * La traducción a `Money` ocurre aquí y no en el cálculo, de modo que el dominio nunca ve un
 * `Decimal` de Prisma (ADR-0010).
 */
@Injectable()
export class PrismaReportingRepository implements ReportingRepository {
  private readonly currency: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  private readonly entityName = 'Informe';

  /**
   * Ventas del periodo.
   *
   * `PAID` y `PARTIALLY_PAID`: lo cobrado es lo cobrado, aunque quede saldo pendiente.
   * Contar solo las saldadas dejaría fuera el dinero que sí ha entrado en la caja del día, y
   * el informe no cuadraría con el arqueo.
   *
   * Las anuladas quedan fuera por el filtro de estado, y las borradas por la extensión.
   */
  async findSales(range: DateRange): Promise<SaleFact[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.invoice.findMany({
        where: this.issuedWithin(range),
        select: { id: true, clientId: true, total: true, currency: true, issuedAt: true },
      }),
    );

    return rows.map((row) => ({
      invoiceId: row.id,
      clientId: row.clientId,
      total: Money.fromDecimal(row.total.toFixed(2), row.currency || this.currency),
      // `issuedAt` no puede ser nulo en una factura emitida, pero el esquema lo permite
      // porque un borrador aún no la tiene. `createdAt` es el respaldo razonable.
      issuedAt: row.issuedAt ?? new Date(),
    }));
  }

  /**
   * Líneas de las ventas del periodo.
   *
   * El nombre del profesional se resuelve en la misma consulta con un `select` anidado, no
   * con una consulta por línea: en un mes con mil líneas serían mil viajes a la base.
   */
  async findSaleLines(range: DateRange): Promise<SaleLineFact[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.invoiceLine.findMany({
        where: { invoice: this.issuedWithin(range) },
        select: {
          kind: true,
          productId: true,
          serviceId: true,
          stylistId: true,
          description: true,
          quantity: true,
          lineSubtotal: true,
          lineTotal: true,
          commissionAmount: true,
          currency: true,
          stylist: { select: { displayName: true, firstName: true, lastName: true } },
        },
      }),
    );

    return rows.map((row) => {
      const currency = row.currency || this.currency;

      return {
        kind: row.kind,
        productId: row.productId,
        serviceId: row.serviceId,
        stylistId: row.stylistId,
        stylistName: row.stylist
          ? (row.stylist.displayName ?? `${row.stylist.firstName} ${row.stylist.lastName}`.trim())
          : null,
        description: row.description,
        quantity: Number(row.quantity),
        lineSubtotal: Money.fromDecimal(row.lineSubtotal.toFixed(2), currency),
        lineTotal: Money.fromDecimal(row.lineTotal.toFixed(2), currency),
        commissionAmount: Money.fromDecimal(row.commissionAmount.toFixed(2), currency),
      };
    });
  }

  /**
   * Citas que solapan el periodo.
   *
   * El solapamiento es `startsAt < fin AND endsAt > inicio`, no `startsAt` dentro del rango:
   * una cita que empieza a las 23:30 y termina a la 00:30 pertenece a los dos días, y
   * filtrar solo por el comienzo la haría desaparecer del informe del segundo.
   */
  async findAppointments(range: DateRange): Promise<AppointmentFact[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.appointment.findMany({
        where: { startsAt: { lt: range.to }, endsAt: { gt: range.from } },
        select: { startsAt: true, endsAt: true, status: true },
      }),
    );

    return rows.map((row) => ({
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      status: row.status,
      isBlocking: row.status !== 'CANCELLED' && row.status !== 'NO_SHOW',
    }));
  }

  async findSchedules(): Promise<ScheduleFact[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.stylistSchedule.findMany({
        select: { dayOfWeek: true, startMinutes: true, endMinutes: true },
      }),
    );

    return rows.map((row) => ({
      dayOfWeek: row.dayOfWeek,
      startMinutes: row.startMinutes,
      endMinutes: row.endMinutes,
    }));
  }

  /** Cuenta en la base con una referencia de campo; no trae las filas para contarlas aquí. */
  async countProductsBelowReorderPoint(): Promise<number> {
    const reorderPoint = (
      this.prisma.client.product as unknown as {
        fields: { reorderPoint: Prisma.DecimalFieldRefInput<'Product'> };
      }
    ).fields.reorderPoint;

    return withMappedErrors(this.entityName, () =>
      this.prisma.client.product.count({
        where: { isActive: true, trackStock: true, stockOnHand: { lte: reorderPoint } },
      }),
    );
  }

  /**
   * Próximas citas, con clienta, profesional y servicios resueltos en una sola consulta.
   *
   * Los nombres se traen con `select` anidados y no con una consulta por cita: son pocas
   * filas, pero el patrón N+1 en la pantalla de inicio es el que más se nota.
   */
  async findUpcomingAppointments(from: Date, limit: number): Promise<UpcomingAppointmentFact[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.appointment.findMany({
        where: { startsAt: { gte: from }, status: { in: UPCOMING_STATUSES } },
        orderBy: { startsAt: 'asc' },
        take: limit,
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          client: { select: { firstName: true, lastName: true } },
          stylist: { select: { displayName: true, firstName: true, lastName: true, color: true } },
          services: { select: { service: { select: { name: true } } } },
        },
      }),
    );

    return rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      status: row.status,
      clientName: `${row.client.firstName} ${row.client.lastName}`.trim(),
      stylistName:
        row.stylist.displayName ?? `${row.stylist.firstName} ${row.stylist.lastName}`.trim(),
      stylistColor: row.stylist.color,
      serviceNames: row.services.map((line) => line.service.name),
    }));
  }

  /** Facturas cobradas —del todo o en parte— emitidas dentro del periodo. */
  private issuedWithin(range: DateRange) {
    return {
      status: { in: PAID_STATUSES },
      issuedAt: { gte: range.from, lt: range.to },
    };
  }
}
