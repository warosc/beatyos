import { Module } from '@nestjs/common';

import { AppointmentsModule } from '../appointments/appointments.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ClientsModule } from '../clients/clients.module';
import { SalesModule } from '../sales/sales.module';
import { StylistsModule } from '../stylists/stylists.module';
import {
  CancelServiceTicketUseCase,
  ChargeServiceTicketUseCase,
  ListAssignableServicesUseCase,
  ListServiceTicketsUseCase,
  RegisterServiceTicketUseCase,
} from './application/service-ticket.use-cases';
import { ServiceTicketsController } from './infrastructure/http/service-tickets.controller';
import { ServiceTicketsPersistenceModule } from './service-tickets-persistence.module';

/**
 * Comandas de servicio (ADR-0019): la profesional declara lo que ha hecho y caja lo cobra.
 *
 * Importa `SalesModule` por `RegisterSaleUseCase`. Cobrar una comanda **es** una venta, y
 * reutilizar la de mostrador es lo que garantiza que precio, impuesto, comisión y arqueo de
 * caja salgan idénticos por los dos caminos.
 */
@Module({
  imports: [
    ServiceTicketsPersistenceModule,
    SalesModule,
    AppointmentsModule,
    CatalogModule,
    ClientsModule,
    StylistsModule,
  ],
  controllers: [ServiceTicketsController],
  providers: [
    RegisterServiceTicketUseCase,
    ChargeServiceTicketUseCase,
    CancelServiceTicketUseCase,
    ListServiceTicketsUseCase,
    ListAssignableServicesUseCase,
  ],
  // Terminar un turno de la fila (ADR-0024) es registrar su comanda por la vía de siempre, y
  // devolverla con su importe, como la devuelve «Mi día».
  exports: [RegisterServiceTicketUseCase, ListServiceTicketsUseCase],
})
export class ServiceTicketsModule {}
