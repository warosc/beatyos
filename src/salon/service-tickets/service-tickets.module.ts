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
import { SERVICE_TICKET_REPOSITORY } from './domain/service-ticket.repository';
import { ServiceTicketsController } from './infrastructure/http/service-tickets.controller';
import { PrismaServiceTicketRepository } from './infrastructure/persistence/prisma-service-ticket.repository';

/**
 * Comandas de servicio (ADR-0019): la profesional declara lo que ha hecho y caja lo cobra.
 *
 * Importa `SalesModule` por `RegisterSaleUseCase`. Cobrar una comanda **es** una venta, y
 * reutilizar la de mostrador es lo que garantiza que precio, impuesto, comisión y arqueo de
 * caja salgan idénticos por los dos caminos.
 */
@Module({
  imports: [SalesModule, AppointmentsModule, CatalogModule, ClientsModule, StylistsModule],
  controllers: [ServiceTicketsController],
  providers: [
    RegisterServiceTicketUseCase,
    ChargeServiceTicketUseCase,
    CancelServiceTicketUseCase,
    ListServiceTicketsUseCase,
    ListAssignableServicesUseCase,
    { provide: SERVICE_TICKET_REPOSITORY, useClass: PrismaServiceTicketRepository },
  ],
})
export class ServiceTicketsModule {}
