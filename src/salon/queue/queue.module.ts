import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../shared/infrastructure/config/env.schema';
import { AppointmentsModule } from '../appointments/appointments.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ClientsModule } from '../clients/clients.module';
import { ServiceTicketsModule } from '../service-tickets/service-tickets.module';
import { StylistsModule } from '../stylists/stylists.module';
import {
  GetQueueBoardUseCase,
  GetQueueDisplayUseCase,
  IssueQueueDisplayLinkUseCase,
} from './application/queue-board.use-cases';
import { GetQueueStatsUseCase } from './application/queue-stats.use-cases';
import {
  CallNextUseCase,
  CallTurnUseCase,
  ChangeQueueTurnUseCase,
  FinishQueueTurnUseCase,
  RegisterWalkInUseCase,
} from './application/queue.use-cases';
import {
  QUEUE_DISPLAY_LINKS,
  QUEUE_SETTINGS,
  QUEUE_STATS_READER,
  QUEUE_TURN_REPOSITORY,
  type QueueSettings,
} from './domain/queue.ports';
import { PublicQueueDisplayController } from './infrastructure/http/public-queue-display.controller';
import { QueueController } from './infrastructure/http/queue.controller';
import {
  PrismaQueueDisplayLinks,
  PrismaQueueStatsReader,
  PrismaQueueTurnRepository,
} from './infrastructure/persistence/prisma-queue.repositories';

/**
 * Fila de espera de clientas sin cita (ADR-0024).
 *
 * No añade infraestructura: los avisos viajan por el canal en vivo de la agenda
 * (`AppointmentsModule`) y terminar un turno es registrar su comanda con el caso de uso de
 * siempre (`ServiceTicketsModule`). Lo único propio es la fila y su pantalla.
 */
@Module({
  imports: [AppointmentsModule, ServiceTicketsModule, CatalogModule, ClientsModule, StylistsModule],
  controllers: [QueueController, PublicQueueDisplayController],
  providers: [
    RegisterWalkInUseCase,
    CallNextUseCase,
    CallTurnUseCase,
    ChangeQueueTurnUseCase,
    FinishQueueTurnUseCase,
    GetQueueBoardUseCase,
    GetQueueDisplayUseCase,
    IssueQueueDisplayLinkUseCase,
    GetQueueStatsUseCase,
    { provide: QUEUE_TURN_REPOSITORY, useClass: PrismaQueueTurnRepository },
    { provide: QUEUE_DISPLAY_LINKS, useClass: PrismaQueueDisplayLinks },
    { provide: QUEUE_STATS_READER, useClass: PrismaQueueStatsReader },
    {
      provide: QUEUE_SETTINGS,
      // Misma zona que la agenda: hoy sale de la configuración global y no de
      // `Tenant.timezone`, deuda anotada en el README para todo el sistema.
      useFactory: (config: ConfigService<Env, true>): QueueSettings => ({
        timeZone: config.get('DEFAULT_TIMEZONE', { infer: true }),
        currency: config.get('DEFAULT_CURRENCY', { infer: true }),
      }),
      inject: [ConfigService],
    },
  ],
})
export class QueueModule {}
