import { ApiProperty } from '@nestjs/swagger';

import { EmptyEnvelopeResponse } from '../../../../shared/infrastructure/http/dto/response-envelope.dto';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { InventoryMovement } from '../../../inventory/domain/inventory-movement.entity';
import type { Product } from '../../../inventory/domain/product.entity';
import type { PurchaseOrderView } from '../../application/purchase-order.use-cases';
import type { PurchaseOrder, PurchaseOrderLine } from '../../domain/purchase-order.entity';
import type { Supplier } from '../../domain/supplier.entity';

/**
 * Presentadores de compras (ADR-0007, ADR-0017).
 *
 * Traducen agregados a la forma que `apps/web` lleva leyendo desde el principio. Existen
 * porque antes no existían: el controlador devolvía filas de Prisma tal cual, de modo que
 * cualquier columna nueva en el esquema aparecía en la API sin que nadie lo decidiera, y
 * cualquier cambio de nombre la rompía.
 *
 * ── Importes y cantidades ───────────────────────────────────────────────────────────
 *
 * Salen como **cadena decimal canónica**: dos decimales el dinero y tres las cantidades,
 * que es la precisión que declara el esquema y lo que el ADR-0010 exige en la frontera
 * JSON. Prisma serializaba su `Decimal` normalizando los ceros —«105» en vez de «105.00»—,
 * que es justo la ambigüedad que ese ADR existe para evitar y que el resto de módulos ya no
 * tiene. Los consumidores conocidos convierten con `Number()` antes de usar el valor, así
 * que la lectura no cambia; lo que cambia es que ahora un importe se distingue de un
 * entero.
 */

export class SupplierResponse {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  addressLine: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  paymentTermDays: number | null;
  notes: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export const toSupplierResponse = (supplier: Supplier): SupplierResponse => ({
  id: supplier.id,
  code: supplier.code,
  name: supplier.name,
  legalName: supplier.legalName,
  taxId: supplier.taxId,
  email: supplier.email,
  phone: supplier.phone,
  contactName: supplier.contactName,
  addressLine: supplier.addressLine,
  city: supplier.city,
  postalCode: supplier.postalCode,
  country: supplier.country,
  paymentTermDays: supplier.paymentTermDays,
  notes: supplier.notes,
  status: supplier.status,
  createdAt: supplier.audit.createdAt,
  updatedAt: supplier.audit.updatedAt,
  deletedAt: supplier.audit.deletedAt,
});

// ---------------------------------------------------------------------------

/**
 * Producto anidado en una línea.
 *
 * Es una proyección, no el producto entero: quien necesite la ficha completa tiene
 * `/products/{id}`. Lleva lo que la pantalla de compras usa —nombre para el formulario de
 * recepción y `tracksBatches` para saber si hay que pedir lote y caducidad— más el coste y
 * el tipo impositivo, que son los datos con los que se compone un pedido.
 */
export class PurchaseProductResponse {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  costPrice: string;
  price: string;
  taxRate: number;
  trackStock: boolean;
  tracksBatches: boolean;
  isActive: boolean;
  stockOnHand: number;
}

const toProductResponse = (product: Product): PurchaseProductResponse => ({
  id: product.id,
  sku: product.sku,
  name: product.name,
  barcode: product.barcode,
  unit: product.unit,
  costPrice: product.costPrice.toDecimalString(),
  price: product.price.toDecimalString(),
  taxRate: product.taxRate.value,
  trackStock: product.trackStock,
  tracksBatches: product.tracksBatches,
  isActive: product.isActive,
  stockOnHand: product.stockOnHand,
});

// ---------------------------------------------------------------------------

export class PurchaseOrderLineResponse {
  id: string;
  purchaseOrderId: string;
  productId: string;
  quantity: string;
  receivedQuantity: string;
  /** Lo que falta por recibir. Lo calculaba la pantalla restando; ahora viaja resuelto. */
  pendingQuantity: string;
  unitCost: string;
  taxRate: number;
  lineSubtotal: string;
  lineTotal: string;
  currency: string;
  notes: string | null;
  product: PurchaseProductResponse | null;
}

export class PurchaseMovementResponse {
  id: string;
  productId: string;
  type: string;
  quantityDelta: number;
  balanceAfter: number;
  unitCost: string | null;
  currency: string | null;
  sourceType: string;
  sourceId: string | null;
  batchId: string | null;
  reason: string | null;
  occurredAt: Date;
}

export class PurchaseOrderResponse {
  id: string;
  number: string;
  status: string;
  supplierId: string;
  orderedAt: Date | null;
  expectedAt: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  supplierReference: string | null;
  notes: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  supplier: SupplierResponse | null;
  lines: PurchaseOrderLineResponse[];
  movements?: PurchaseMovementResponse[];
}

/** Formas HTTP reales después de aplicar ResponseEnvelopeInterceptor. */
export class SupplierEnvelopeResponse {
  @ApiProperty({ type: SupplierResponse }) data!: SupplierResponse;
}

export class SupplierPageResponse {
  @ApiProperty({ type: [SupplierResponse] }) data!: SupplierResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export class PurchaseOrderEnvelopeResponse {
  @ApiProperty({ type: PurchaseOrderResponse }) data!: PurchaseOrderResponse;
}

export class PurchaseOrderPageResponse {
  @ApiProperty({ type: [PurchaseOrderResponse] }) data!: PurchaseOrderResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export { EmptyEnvelopeResponse };

const toLineResponse = (
  order: PurchaseOrder,
  line: PurchaseOrderLine,
  products: ReadonlyMap<string, Product>,
): PurchaseOrderLineResponse => {
  const product = products.get(line.productId);

  return {
    id: line.id,
    purchaseOrderId: order.id,
    productId: line.productId,
    quantity: line.quantity.toDecimalString(),
    receivedQuantity: line.receivedQuantity.toDecimalString(),
    pendingQuantity: order.pendingOf(line).toDecimalString(),
    unitCost: line.unitCost.toDecimalString(),
    taxRate: line.taxRate.value,
    lineSubtotal: line.lineSubtotal.toDecimalString(),
    lineTotal: line.lineTotal.toDecimalString(),
    currency: line.lineTotal.currency,
    notes: line.notes,
    product: product ? toProductResponse(product) : null,
  };
};

const toMovementResponse = (movement: InventoryMovement): PurchaseMovementResponse => ({
  id: movement.id,
  productId: movement.productId,
  type: movement.type,
  quantityDelta: movement.quantityDelta,
  balanceAfter: movement.balanceAfter,
  unitCost: movement.unitCost?.toDecimalString() ?? null,
  currency: movement.unitCost?.currency ?? null,
  sourceType: movement.sourceType,
  sourceId: movement.sourceId,
  batchId: movement.batchId,
  reason: movement.reason,
  occurredAt: movement.occurredAt,
});

export const toPurchaseOrderResponse = (
  view: PurchaseOrderView,
  options: { withMovements: boolean },
): PurchaseOrderResponse => {
  const { order } = view;

  return {
    id: order.id,
    number: order.number,
    status: order.status,
    supplierId: order.supplierId,
    orderedAt: order.orderedAt,
    expectedAt: order.expectedAt,
    receivedAt: order.receivedAt,
    cancelledAt: order.cancelledAt,
    cancellationReason: order.cancellationReason,
    supplierReference: order.supplierReference,
    notes: order.notes,
    subtotal: order.subtotal.toDecimalString(),
    taxTotal: order.taxTotal.toDecimalString(),
    total: order.total.toDecimalString(),
    currency: order.currency,
    createdAt: order.audit.createdAt,
    updatedAt: order.audit.updatedAt,
    supplier: view.supplier ? toSupplierResponse(view.supplier) : null,
    lines: order.lines.map((line) => toLineResponse(order, line, view.products)),
    ...(options.withMovements
      ? { movements: view.movements.map((movement) => toMovementResponse(movement)) }
      : {}),
  };
};
