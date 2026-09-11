import { Module } from '@nestjs/common';

import {
  AdjustStockUseCase,
  ConsumeStockUseCase,
  CreateProductUseCase,
  DeleteProductUseCase,
  GetKardexUseCase,
  GetProductUseCase,
  GetStockAlertsUseCase,
  ReceiveStockUseCase,
  RestoreProductUseCase,
  SearchBatchesUseCase,
  SearchProductsUseCase,
  UpdateProductUseCase,
} from './application/inventory.use-cases';
import {
  BATCH_REPOSITORY,
  MOVEMENT_REPOSITORY,
  PRODUCT_REPOSITORY,
} from './domain/inventory.repositories';
import {
  InventoryController,
  ProductsController,
} from './infrastructure/http/inventory.controllers';
import {
  PrismaBatchRepository,
  PrismaMovementRepository,
  PrismaProductRepository,
} from './infrastructure/persistence/prisma-inventory.repositories';

/**
 * Modulo de inventario: productos, lotes y kardex.
 *
 * Los tres van juntos porque son un mismo contexto. Separar el producto del lote obligaria
 * a que cada modulo importase al otro —una entrada toca los dos a la vez, en la misma
 * transaccion— y esa dependencia circular es la senal de que en realidad son uno.
 *
 * Exporta los tres puertos porque la venta, la caja y los informes necesitan descontar
 * existencias y leer costes. Lo que exporta son **puertos**, no los adaptadores: quien los
 * consume depende del contrato del dominio y no de que por debajo haya Prisma (ADR-0001).
 */
@Module({
  controllers: [ProductsController, InventoryController],
  providers: [
    CreateProductUseCase,
    UpdateProductUseCase,
    GetProductUseCase,
    SearchProductsUseCase,
    DeleteProductUseCase,
    RestoreProductUseCase,
    ReceiveStockUseCase,
    ConsumeStockUseCase,
    AdjustStockUseCase,
    GetKardexUseCase,
    SearchBatchesUseCase,
    GetStockAlertsUseCase,
    { provide: PRODUCT_REPOSITORY, useClass: PrismaProductRepository },
    { provide: BATCH_REPOSITORY, useClass: PrismaBatchRepository },
    { provide: MOVEMENT_REPOSITORY, useClass: PrismaMovementRepository },
  ],
  exports: [
    PRODUCT_REPOSITORY,
    BATCH_REPOSITORY,
    MOVEMENT_REPOSITORY,
    // La venta y el consumo en cabina descuentan existencias por FEFO. Se exporta el caso
    // de uso, no el repositorio de lotes: reimplementar el reparto en el modulo de ventas
    // seria tener dos motores de inventario que divergen (ADR-0002).
    ConsumeStockUseCase,
    ReceiveStockUseCase,
  ],
})
export class InventoryModule {}
