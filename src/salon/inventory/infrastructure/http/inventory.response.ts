import { ApiProperty } from '@nestjs/swagger';

import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { BatchListing, KardexEntry, StockAlerts } from '../../application/inventory.use-cases';
import type { Batch } from '../../domain/batch.entity';
import type { InventoryMovement } from '../../domain/inventory-movement.entity';
import type { Product } from '../../domain/product.entity';

/**
 * Presentadores de inventario (ADR-0011, ADR-0012, ADR-0013).
 *
 * Las cantidades salen con tres decimales y los importes con dos, siempre como **cadena**:
 * un `numeric` de PostgreSQL no cabe exacto en un `number` de JavaScript (ADR-0010). Las
 * clases son la misma forma que ya devolvían los presentadores; lo único que añaden es que
 * el plugin de Swagger puede describirlas.
 */

export class ProductResponse {
  id!: string;
  sku!: string;
  barcode!: string | null;
  name!: string;
  description!: string | null;
  brand!: string | null;
  categoryId!: string | null;
  price!: string;
  /** Se omite, no se pone a `null`, cuando quien consulta no tiene el permiso de costes. */
  costPrice?: string;
  stockValue?: string;
  marginPercentage?: number | null;
  currency!: string;
  taxRate!: string;
  unit!: string;
  stockOnHand!: string;
  reorderPoint!: string;
  reorderQuantity!: string;
  stockStatus!: string;
  isRetail!: boolean;
  isInternal!: boolean;
  isActive!: boolean;
  trackStock!: boolean;
  tracksBatches!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt!: Date | null;
}

export const toProductResponse = (product: Product, includeCosts: boolean): ProductResponse => ({
  id: product.id,
  sku: product.sku,
  barcode: product.barcode,
  name: product.name,
  description: product.description,
  brand: product.brand,
  categoryId: product.categoryId,
  price: product.price.toDecimalString(),
  ...(includeCosts
    ? {
        costPrice: product.costPrice.toDecimalString(),
        stockValue: product.stockValue.toDecimalString(),
        marginPercentage: product.marginPercentage(),
      }
    : {}),
  currency: product.price.currency,
  taxRate: product.taxRate.value.toFixed(2),
  unit: product.unit,
  stockOnHand: product.stockOnHand.toFixed(3),
  reorderPoint: product.reorderPoint.toFixed(3),
  reorderQuantity: product.reorderQuantity.toFixed(3),
  stockStatus: product.stockStatus,
  isRetail: product.isRetail,
  isInternal: product.isInternal,
  isActive: product.isActive,
  trackStock: product.trackStock,
  tracksBatches: product.tracksBatches,
  createdAt: product.audit.createdAt,
  updatedAt: product.audit.updatedAt,
  deletedAt: product.audit.deletedAt,
});

/** Referencia mínima al producto, para no repetir el catálogo entero en cada fila. */
export class ProductRefResponse {
  sku!: string;
  name!: string;
}

export class InventoryMovementResponse {
  id!: string;
  productId!: string;
  type!: string;
  quantityDelta!: string;
  balanceAfter!: string;
  unitCost!: string | null;
  currency!: string | null;
  sourceType!: string | null;
  sourceId!: string | null;
  reason!: string | null;
  notes!: string | null;
  batchId!: string | null;
  occurredAt!: Date;
}

export const toMovementResponse = (movement: InventoryMovement): InventoryMovementResponse => ({
  id: movement.id,
  productId: movement.productId,
  type: movement.type,
  quantityDelta: movement.quantityDelta.toFixed(3),
  balanceAfter: movement.balanceAfter.toFixed(3),
  unitCost: movement.unitCost?.toDecimalString() ?? null,
  currency: movement.unitCost?.currency ?? null,
  sourceType: movement.sourceType,
  sourceId: movement.sourceId,
  reason: movement.reason,
  notes: movement.notes,
  batchId: movement.batchId,
  occurredAt: movement.occurredAt,
});

export class KardexEntryResponse extends InventoryMovementResponse {
  product!: ProductRefResponse | null;
  batch!: { batchNumber: string } | null;
}

export const toKardexEntryResponse = (entry: KardexEntry): KardexEntryResponse => ({
  ...toMovementResponse(entry.movement),
  product: entry.product ? { sku: entry.product.sku, name: entry.product.name } : null,
  batch: entry.batch ? { batchNumber: entry.batch.batchNumber } : null,
});

export class BatchResponse {
  id!: string;
  productId!: string;
  batchNumber!: string;
  expiresAt!: Date | null;
  receivedAt!: Date;
  initialQuantity!: string;
  remainingQuantity!: string;
  unitCost!: string;
  currency!: string;
  supplierId!: string | null;
  notes!: string | null;
}

export const toBatchResponse = (batch: Batch): BatchResponse => ({
  id: batch.id,
  productId: batch.productId,
  batchNumber: batch.batchNumber,
  expiresAt: batch.expiresAt,
  receivedAt: batch.receivedAt,
  initialQuantity: batch.initialQuantity.toFixed(3),
  remainingQuantity: batch.remainingQuantity.toFixed(3),
  unitCost: batch.unitCost.toDecimalString(),
  currency: batch.unitCost.currency,
  supplierId: batch.supplierId,
  notes: batch.notes,
});

export class BatchListingResponse extends BatchResponse {
  product!: ProductRefResponse | null;
}

export const toBatchListingResponse = (listing: BatchListing): BatchListingResponse => ({
  ...toBatchResponse(listing.batch),
  product: listing.product ? { sku: listing.product.sku, name: listing.product.name } : null,
});

export class ReorderAlertResponse {
  id!: string;
  sku!: string;
  name!: string;
  stockOnHand!: string;
  reorderPoint!: string;
  missing!: string;
  suggestedOrder!: string;
  stockStatus!: string;
}

export class ExpiringBatchResponse extends BatchResponse {
  daysLeft!: number | null;
}

export class StockAlertsResponse {
  @ApiProperty({ type: [ReorderAlertResponse] }) reorder!: ReorderAlertResponse[];
  @ApiProperty({ type: [ExpiringBatchResponse] }) expiring!: ExpiringBatchResponse[];
  @ApiProperty({ type: [BatchResponse] }) expired!: BatchResponse[];
}

export const toStockAlertsResponse = (alerts: StockAlerts): StockAlertsResponse => ({
  reorder: alerts.reorder.map((item) => ({
    id: item.product.id,
    sku: item.product.sku,
    name: item.product.name,
    stockOnHand: item.product.stockOnHand.toFixed(3),
    reorderPoint: item.product.reorderPoint.toFixed(3),
    missing: item.missing.toFixed(3),
    suggestedOrder: item.suggestedOrder.toFixed(3),
    stockStatus: item.product.stockStatus,
  })),
  expiring: alerts.expiring.map((item) => ({
    ...toBatchResponse(item.batch),
    daysLeft: item.daysLeft,
  })),
  expired: alerts.expired.map(toBatchResponse),
});

export class ReceiveStockResponse extends InventoryMovementResponse {
  @ApiProperty({ type: BatchResponse, nullable: true }) batch!: BatchResponse | null;
}

export class ConsumeStockResponse {
  @ApiProperty({ type: [InventoryMovementResponse] }) movements!: InventoryMovementResponse[];
  balanceAfter!: string;
  totalCost!: string;
  currency!: string;
}

export class AdjustStockResponse extends InventoryMovementResponse {
  @ApiProperty({ type: [InventoryMovementResponse] }) movements!: InventoryMovementResponse[];
}

// ---------------------------------------------------------------------------
// Envolturas HTTP (ResponseEnvelopeInterceptor)
// ---------------------------------------------------------------------------

export class ProductEnvelopeResponse {
  @ApiProperty({ type: ProductResponse }) data!: ProductResponse;
}

export class ProductPageResponse {
  @ApiProperty({ type: [ProductResponse] }) data!: ProductResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export class KardexPageResponse {
  @ApiProperty({ type: [KardexEntryResponse] }) data!: KardexEntryResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export class BatchPageResponse {
  @ApiProperty({ type: [BatchListingResponse] }) data!: BatchListingResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export class StockAlertsEnvelopeResponse {
  @ApiProperty({ type: StockAlertsResponse }) data!: StockAlertsResponse;
}

export class ReceiveStockEnvelopeResponse {
  @ApiProperty({ type: ReceiveStockResponse }) data!: ReceiveStockResponse;
}

export class ConsumeStockEnvelopeResponse {
  @ApiProperty({ type: ConsumeStockResponse }) data!: ConsumeStockResponse;
}

export class AdjustStockEnvelopeResponse {
  @ApiProperty({ type: AdjustStockResponse }) data!: AdjustStockResponse;
}
