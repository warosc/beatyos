import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import { RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  GetDashboardUseCase,
  GetExecutiveReportUseCase,
  type DashboardReport,
  type ExecutiveReport,
} from '../../application/reports.use-cases';

export class ReportPeriodDto {
  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

@ApiTags('Informes')
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(
    private readonly executive: GetExecutiveReportUseCase,
    private readonly dashboard: GetDashboardUseCase,
  ) {}

  @Get('executive')
  @RequirePermissions(PERMISSIONS.reports.read)
  @ApiOperation({ summary: 'Indicadores del periodo. Por defecto, los últimos 30 días' })
  async executiveReport(@Query() query: ReportPeriodDto) {
    return presentReport(await this.executive.execute({ from: query.from, to: query.to }));
  }

  @Get('dashboard')
  @RequirePermissions(PERMISSIONS.reports.read)
  @ApiOperation({ summary: 'Panel del día: indicadores, reposición pendiente y estado de caja' })
  async dashboardReport(@Query() query: ReportPeriodDto) {
    const report = await this.dashboard.execute({ from: query.from, to: query.to });
    return presentDashboard(report);
  }
}

// ---------------------------------------------------------------------------

/**
 * Informe serializado.
 *
 * Los importes salen como cadena decimal y los porcentajes como número: un porcentaje no es
 * dinero y no necesita la exactitud de `Money`, mientras que un importe serializado como
 * `number` pierde por el camino la precisión que se mantiene en toda la pila (ADR-0010).
 *
 * `period` y `timeZone` viajan en la respuesta a propósito: un dato como «retención del
 * 34 %» no significa nada sin saber sobre qué ventana se ha medido, y la serie diaria está
 * agrupada en hora del salón, no en UTC.
 */
const presentReport = (report: ExecutiveReport) => ({
  period: {
    from: report.period.from.toISOString(),
    to: report.period.to.toISOString(),
  },
  timeZone: report.timeZone,
  currency: report.currency,
  sales: report.sales.toDecimalString(),
  tickets: report.tickets,
  averageTicket: report.averageTicket.toDecimalString(),
  retentionRate: report.retentionRate,
  occupancyRate: report.occupancy.rate,
  bookedMinutes: report.occupancy.bookedMinutes,
  capacityMinutes: report.occupancy.capacityMinutes,
  completedAppointments: report.appointments.COMPLETED ?? 0,
  cancelledAppointments: report.appointments.CANCELLED ?? 0,
  noShowAppointments: report.appointments.NO_SHOW ?? 0,
  appointmentsByStatus: report.appointments,
  commissionTotal: report.commissionTotal.toDecimalString(),
  topProducts: report.topProducts.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity.toFixed(3),
    revenue: item.revenue.toDecimalString(),
  })),
  topStylists: report.topStylists.map((item) => ({
    id: item.id,
    name: item.name,
    revenue: item.revenue.toDecimalString(),
    services: item.services.toFixed(3),
    commission: item.commission.toDecimalString(),
  })),
  dailySales: report.dailySales.map((item) => ({
    date: item.date,
    total: item.total.toDecimalString(),
  })),
});

const presentDashboard = (report: DashboardReport) => ({
  ...presentReport(report),
  lowStockCount: report.lowStockCount,
  // El panel une los servicios con «+» porque es como se lee una cita de varios pasos en
  // una sola linea: «Color + Corte». La lista cruda obligaria a que cada consumidor
  // decidiera el separador por su cuenta, y acabarian siendo tres distintos.
  upcoming: report.upcoming.map((item) => ({
    id: item.id,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    status: item.status,
    client: item.clientName,
    stylist: item.stylistName,
    stylistColor: item.stylistColor,
    service: item.serviceNames.join(' + '),
  })),
  cash: report.cash
    ? {
        isOpen: report.cash.session.isOpen,
        openedAt: report.cash.session.openedAt,
        openingFloat: report.cash.session.openingFloat.toDecimalString(),
        cashSales: report.cash.cashSales.toDecimalString(),
        expected: report.cash.expectedAmount.toDecimalString(),
      }
    : { isOpen: false, openedAt: null, openingFloat: '0.00', cashSales: '0.00', expected: '0.00' },
});
