import { Module } from '@nestjs/common';

import { SERVICE_TICKET_REPOSITORY } from './domain/service-ticket.repository';
import { PrismaServiceTicketRepository } from './infrastructure/persistence/prisma-service-ticket.repository';

/**
 * Persistencia de comandas, aislada del resto del módulo.
 *
 * Rompe el mismo tipo de ciclo que `SalesPersistenceModule`: comandas necesita ventas
 * —cobrar una comanda es una venta— y ventas necesita las comandas —anular una venta
 * devuelve a caja la comanda que cobró (ADR-0020)—. Con solo el repositorio aquí, ventas
 * depende de este módulo y comandas de ventas, sin que ninguno importe al otro entero.
 */
@Module({
  providers: [{ provide: SERVICE_TICKET_REPOSITORY, useClass: PrismaServiceTicketRepository }],
  exports: [SERVICE_TICKET_REPOSITORY],
})
export class ServiceTicketsPersistenceModule {}
