import { Module } from '@nestjs/common';

import { CashModule } from '../cash/cash.module';
import { GetDashboardUseCase, GetExecutiveReportUseCase } from './application/reports.use-cases';
import { REPORTING_REPOSITORY } from './domain/reporting.repository';
import { ReportsController } from './infrastructure/http/reports.controller';
import { PrismaReportingRepository } from './infrastructure/persistence/prisma-reporting.repository';

/**
 * Modulo de informes.
 *
 * Importa caja porque el panel del dia muestra el estado del cajon, y lo pide al caso de uso
 * de caja en lugar de recalcular el efectivo esperado. Esa cuenta llego a estar escrita tres
 * veces en el sistema —en la pantalla de caja, en el cierre y aqui—, y bastaba con que una
 * olvidara un tipo de movimiento para que el panel y el arqueo dieran cifras distintas sin
 * que nadie supiera cual creer (ADR-0002).
 *
 * No importa ventas ni inventario: sus datos entran por `ReportingRepository`, un puerto de
 * lectura cuya forma la dicta la pregunta —«cuanto se ha vendido este mes»— y no el agregado.
 */
@Module({
  imports: [CashModule],
  controllers: [ReportsController],
  providers: [
    GetExecutiveReportUseCase,
    GetDashboardUseCase,
    { provide: REPORTING_REPOSITORY, useClass: PrismaReportingRepository },
  ],
  exports: [REPORTING_REPOSITORY],
})
export class ReportsModule {}
