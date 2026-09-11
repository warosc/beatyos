import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../shared/infrastructure/config/env.schema';
import {
  AddTimeOffUseCase,
  CreateStylistUseCase,
  DeleteStylistUseCase,
  GetStylistUseCase,
  GetStylistWorkingHoursUseCase,
  RemoveTimeOffUseCase,
  RestoreStylistUseCase,
  SALON_CONTEXT,
  SearchStylistsUseCase,
  SetStylistScheduleUseCase,
  SetStylistSkillsUseCase,
  UpdateStylistUseCase,
  type SalonContext,
} from './application/stylist.use-cases';
import { STYLIST_REPOSITORY } from './domain/stylist.repository';
import { StylistsController } from './infrastructure/http/stylists.controller';
import { PrismaStylistRepository } from './infrastructure/persistence/prisma-stylist.repository';

/**
 * Módulo de profesionales.
 *
 * Exporta el puerto del repositorio porque la agenda lo necesita: para saber si una cita
 * cabe hay que preguntar por el horario, y esa pregunta la responde este agregado.
 */
@Module({
  controllers: [StylistsController],
  providers: [
    CreateStylistUseCase,
    UpdateStylistUseCase,
    GetStylistUseCase,
    SearchStylistsUseCase,
    DeleteStylistUseCase,
    RestoreStylistUseCase,
    SetStylistScheduleUseCase,
    AddTimeOffUseCase,
    RemoveTimeOffUseCase,
    SetStylistSkillsUseCase,
    GetStylistWorkingHoursUseCase,
    { provide: STYLIST_REPOSITORY, useClass: PrismaStylistRepository },
    {
      /**
       * Contexto del salón.
       *
       * **Simplificación consciente**: la zona horaria sale de la configuración global y
       * no de la fila `Tenant`, que es donde está la de verdad. Hoy todos los salones
       * comparten zona y leerla por petición exigiría una consulta más en cada cálculo de
       * disponibilidad.
       *
       * Deja de valer en cuanto la plataforma tenga salones en husos distintos. La salida
       * es un proveedor con ámbito de petición que lea `Tenant.timezone` con caché por
       * inquilino, y por eso esto ya es un puerto y no una constante suelta: cambiarlo
       * será tocar solo este bloque.
       */
      provide: SALON_CONTEXT,
      useFactory: (config: ConfigService<Env, true>): SalonContext => ({
        timeZone: config.get('DEFAULT_TIMEZONE', { infer: true }),
      }),
      inject: [ConfigService],
    },
  ],
  exports: [STYLIST_REPOSITORY, SALON_CONTEXT],
})
export class StylistsModule {}
