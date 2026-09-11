import { Module } from '@nestjs/common';

import {
  CreateCategoryUseCase,
  CreateServiceUseCase,
  DeleteCategoryUseCase,
  DeleteServiceUseCase,
  GetCategoryTreeUseCase,
  GetServiceUseCase,
  RestoreServiceUseCase,
  SearchCategoriesUseCase,
  SearchServicesUseCase,
  SetServiceConsumablesUseCase,
  UpdateCategoryUseCase,
  UpdateServiceUseCase,
} from './application/catalog.use-cases';
import { CATEGORY_REPOSITORY, SERVICE_REPOSITORY } from './domain/catalog.repositories';
import {
  CategoriesController,
  ServicesController,
} from './infrastructure/http/catalog.controllers';
import {
  PrismaCategoryRepository,
  PrismaServiceRepository,
} from './infrastructure/persistence/prisma-catalog.repositories';

/**
 * Modulo de catalogo: servicios y categorias.
 *
 * Van juntos porque son un mismo contexto —lo que el salon ofrece— y porque el alta de un
 * servicio necesita validar su categoria. Separarlos obligaria a que cada uno importase el
 * modulo del otro, que es la senal de que en realidad son uno.
 *
 * Exporta el puerto de servicios porque la agenda lo necesita: una cita se compone de
 * servicios, y sus precios y duraciones se congelan al reservar.
 */
@Module({
  controllers: [ServicesController, CategoriesController],
  providers: [
    CreateServiceUseCase,
    UpdateServiceUseCase,
    GetServiceUseCase,
    SearchServicesUseCase,
    DeleteServiceUseCase,
    RestoreServiceUseCase,
    SetServiceConsumablesUseCase,
    CreateCategoryUseCase,
    UpdateCategoryUseCase,
    SearchCategoriesUseCase,
    GetCategoryTreeUseCase,
    DeleteCategoryUseCase,
    { provide: SERVICE_REPOSITORY, useClass: PrismaServiceRepository },
    { provide: CATEGORY_REPOSITORY, useClass: PrismaCategoryRepository },
  ],
  exports: [SERVICE_REPOSITORY, CATEGORY_REPOSITORY],
})
export class CatalogModule {}
