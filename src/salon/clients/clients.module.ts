import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';

import type { Env } from '../../shared/infrastructure/config/env.schema';

import {
  DeleteClientPhotoUseCase,
  DescribeClientPhotoUseCase,
  PurgeDeletedPhotosUseCase,
  SearchClientPhotosUseCase,
  UploadClientPhotoUseCase,
} from './application/client-photo.use-cases';
import {
  AnonymizeClientUseCase,
  CreateClientUseCase,
  DeleteClientUseCase,
  GetClientUseCase,
  RestoreClientUseCase,
  SearchClientsUseCase,
  UpdateClientUseCase,
} from './application/client.use-cases';
import { CLIENT_PHOTO_REPOSITORY } from './domain/client-photo.repository';
import { CLIENT_REPOSITORY } from './domain/client.repository';
import {
  ClientPhotosController,
  PhotoMaintenanceController,
} from './infrastructure/http/client-photos.controller';
import { ClientsController } from './infrastructure/http/clients.controller';
import { PrismaClientPhotoRepository } from './infrastructure/persistence/prisma-client-photo.repository';
import { PrismaClientRepository } from './infrastructure/persistence/prisma-client.repository';

/**
 * Modulo de clientas y su historial fotografico.
 *
 * Se exporta el **puerto**, no el adaptador: los modulos que necesiten leer clientas
 * —agenda, facturacion— inyectan `CLIENT_REPOSITORY` y no pueden acoplarse a Prisma ni
 * queriendo, porque no tienen forma de nombrar la clase concreta (ADR-0001).
 */
@Module({
  imports: [
    // El tope de la foto se aplica mientras llega, no después: sin `limits`, multer carga
    // en memoria el fichero entero —cien megas, si los manda— antes de que nadie lo mire.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        limits: {
          fileSize: config.get('PHOTO_MAX_BYTES', { infer: true }),
          files: 1,
          fields: 20,
        },
      }),
    }),
  ],
  controllers: [ClientsController, ClientPhotosController, PhotoMaintenanceController],
  providers: [
    CreateClientUseCase,
    UpdateClientUseCase,
    GetClientUseCase,
    SearchClientsUseCase,
    DeleteClientUseCase,
    RestoreClientUseCase,
    AnonymizeClientUseCase,
    UploadClientPhotoUseCase,
    SearchClientPhotosUseCase,
    DescribeClientPhotoUseCase,
    DeleteClientPhotoUseCase,
    PurgeDeletedPhotosUseCase,
    { provide: CLIENT_REPOSITORY, useClass: PrismaClientRepository },
    { provide: CLIENT_PHOTO_REPOSITORY, useClass: PrismaClientPhotoRepository },
  ],
  exports: [CLIENT_REPOSITORY, CLIENT_PHOTO_REPOSITORY],
})
export class ClientsModule {}
