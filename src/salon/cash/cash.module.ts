import { Module } from '@nestjs/common';

import { SalesPersistenceModule } from '../sales/sales-persistence.module';
import {
  CloseCashSessionUseCase,
  GetCurrentCashSessionUseCase,
  OpenCashSessionUseCase,
  RecordCashMovementUseCase,
  SearchCashSessionsUseCase,
} from './application/cash.use-cases';
import { CASH_SESSION_REPOSITORY } from './domain/cash.repositories';
import { CashController } from './infrastructure/http/cash.controllers';
import { PrismaCashSessionRepository } from './infrastructure/persistence/prisma-cash.repositories';

/**
 * Modulo de caja.
 *
 * Importa la persistencia de ventas —no el modulo de ventas entero— porque el arqueo
 * necesita saber cuanto se ha cobrado en efectivo, y eso vive en los cobros. Traerse el
 * modulo completo crearia una dependencia circular: ventas necesita caja para saber a que
 * sesion imputar un cobro en efectivo, y caja necesita los cobros para cuadrar.
 *
 * Un modulo aparte solo con los puertos de persistencia rompe ese ciclo sin duplicar nada:
 * los dos dependen de los mismos adaptadores y ninguno depende del otro.
 */
@Module({
  imports: [SalesPersistenceModule],
  controllers: [CashController],
  providers: [
    GetCurrentCashSessionUseCase,
    OpenCashSessionUseCase,
    RecordCashMovementUseCase,
    CloseCashSessionUseCase,
    SearchCashSessionsUseCase,
    { provide: CASH_SESSION_REPOSITORY, useClass: PrismaCashSessionRepository },
  ],
  // Se exporta el caso de uso ademas del puerto: el panel del dia necesita el efectivo
  // esperado y tiene que obtenerlo de la misma cuenta que usa el arqueo, no de una copia
  // propia. Exportar solo el repositorio invitaria justo a esa copia (ADR-0002).
  exports: [CASH_SESSION_REPOSITORY, GetCurrentCashSessionUseCase],
})
export class CashModule {}
