import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import {
  CancelPurchaseOrderUseCase,
  CreatePurchaseOrderUseCase,
  GetPurchaseOrderUseCase,
  ListPurchaseOrdersUseCase,
  PurchaseOrderViewFactory,
  ReceivePurchaseOrderUseCase,
  SubmitPurchaseOrderUseCase,
} from './application/purchase-order.use-cases';
import {
  CreateSupplierUseCase,
  DeleteSupplierUseCase,
  ListSuppliersUseCase,
  RestoreSupplierUseCase,
  UpdateSupplierUseCase,
} from './application/supplier.use-cases';
import {
  PURCHASE_ORDER_NUMBER_GENERATOR,
  PURCHASE_ORDER_REPOSITORY,
  SUPPLIER_REPOSITORY,
} from './domain/purchases.repositories';
import {
  PurchasesController,
  SuppliersController,
} from './infrastructure/http/purchases.controller';
import {
  PrismaPurchaseOrderNumberGenerator,
  PrismaPurchaseOrderRepository,
  PrismaSupplierRepository,
} from './infrastructure/persistence/prisma-purchases.repositories';

/**
 * Módulo de compras: proveedores y pedidos.
 *
 * Importa inventario porque una recepción da entrada a existencias, y lo que usa de él es
 * `ReceiveStockUseCase`: el motor con reparto por lotes, coste real y descuento atómico del
 * ADR-0013. Reimplementar aquí cualquier parte de eso sería tener dos motores de
 * existencias en el mismo sistema, que es lo que el ADR-0002 prohíbe y lo que el ADR-0014
 * acabó de arreglar en ventas.
 *
 * El cableado de puertos con adaptadores ocurre **solo aquí** (ADR-0001). Antes no había
 * nada que cablear: el servicio recibía `PrismaService` directamente, y esa era exactamente
 * la excepción arquitectónica que este módulo dejó de ser.
 */
@Module({
  imports: [InventoryModule],
  controllers: [SuppliersController, PurchasesController],
  providers: [
    ListSuppliersUseCase,
    CreateSupplierUseCase,
    UpdateSupplierUseCase,
    DeleteSupplierUseCase,
    RestoreSupplierUseCase,
    ListPurchaseOrdersUseCase,
    GetPurchaseOrderUseCase,
    CreatePurchaseOrderUseCase,
    SubmitPurchaseOrderUseCase,
    ReceivePurchaseOrderUseCase,
    CancelPurchaseOrderUseCase,
    PurchaseOrderViewFactory,
    { provide: SUPPLIER_REPOSITORY, useClass: PrismaSupplierRepository },
    { provide: PURCHASE_ORDER_REPOSITORY, useClass: PrismaPurchaseOrderRepository },
    {
      provide: PURCHASE_ORDER_NUMBER_GENERATOR,
      useClass: PrismaPurchaseOrderNumberGenerator,
    },
  ],
})
export class PurchasesModule {}
