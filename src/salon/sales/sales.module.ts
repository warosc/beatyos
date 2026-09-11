import { Module } from '@nestjs/common';

import { CashModule } from '../cash/cash.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ClientsModule } from '../clients/clients.module';
import { InventoryModule } from '../inventory/inventory.module';
import { StylistsModule } from '../stylists/stylists.module';
import {
  GetInvoiceUseCase,
  RegisterSaleUseCase,
  SearchInvoicesUseCase,
  VoidInvoiceUseCase,
} from './application/sales.use-cases';
import { SalesController } from './infrastructure/http/sales.controllers';
import { SalesPersistenceModule } from './sales-persistence.module';

/**
 * Modulo de ventas y facturacion.
 *
 * Importa inventario y catalogo porque una venta necesita los precios congelados y el
 * descuento de existencias. Lo que **no** hace es reimplementar ninguna de las dos cosas:
 * usa `ConsumeStockUseCase`, que es el motor FEFO del ADR-0013.
 *
 * Esa delegacion es la diferencia entre esta version y la anterior. La anterior escribia
 * `stockOnHand` y creaba el movimiento de inventario por su cuenta, con lo que habia dos
 * motores de existencias en el mismo sistema: el de inventario, que respetaba los lotes, y
 * el de ventas, que se los saltaba. Un tinte trazado se vendia sin tocar ningun lote y la
 * trazabilidad quedaba rota justo en la operacion que la necesita (ADR-0002).
 */
@Module({
  imports: [
    SalesPersistenceModule,
    InventoryModule,
    CatalogModule,
    CashModule,
    ClientsModule,
    StylistsModule,
  ],
  controllers: [SalesController],
  providers: [RegisterSaleUseCase, SearchInvoicesUseCase, GetInvoiceUseCase, VoidInvoiceUseCase],
  exports: [SalesPersistenceModule],
})
export class SalesModule {}
