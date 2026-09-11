import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import { BusinessRuleViolationError, ConflictError } from '../../../shared/domain/errors';
import {
  UNIT_OF_WORK,
  type Page,
  type PageRequest,
  type UnitOfWork,
} from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import { Batch } from '../domain/batch.entity';
import {
  InventoryMovement,
  type MovementSourceTypeValue,
  type MovementTypeValue,
} from '../domain/inventory-movement.entity';
import {
  BATCH_REPOSITORY,
  MOVEMENT_REPOSITORY,
  PRODUCT_REPOSITORY,
  type BatchFilter,
  type BatchRepository,
  type BatchSortField,
  type MovementFilter,
  type MovementRepository,
  type MovementSortField,
  type ProductFilter,
  type ProductRepository,
  type ProductSortField,
} from '../domain/inventory.repositories';
import { Product, type ProductUnitValue } from '../domain/product.entity';
import { StockAllocationService } from '../domain/stock-allocation.service';

// ===========================================================================
// Productos
// ===========================================================================

export interface CreateProductInput {
  readonly tenantId: string;
  readonly sku: string;
  readonly name: string;
  readonly price: string;
  readonly currency: string;
  readonly costPrice?: string;
  readonly categoryId?: string | null;
  readonly barcode?: string | null;
  readonly description?: string | null;
  readonly brand?: string | null;
  readonly taxRate?: number;
  readonly unit?: ProductUnitValue;
  readonly reorderPoint?: number;
  readonly reorderQuantity?: number;
  readonly isRetail?: boolean;
  readonly isInternal?: boolean;
  readonly trackStock?: boolean;
  readonly tracksBatches?: boolean;
  readonly actorId: string | null;
}

@Injectable()
export class CreateProductUseCase implements UseCase<CreateProductInput, Product> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: CreateProductInput): Promise<Product> {
    // Se busca incluyendo los borrados a propósito: el índice único es parcial, así que un
    // SKU dado de baja se puede reutilizar. Pero decirlo cambia la respuesta útil —«hay uno
    // eliminado, recupérelo»— por un error de duplicado que no explica nada.
    const existing = await this.products.findBySku(input.sku, { includeDeleted: true });
    if (existing) {
      throw new ConflictError(
        existing.isDeleted ? 'PRODUCT_SKU_EXISTS_DELETED' : 'PRODUCT_SKU_ALREADY_EXISTS',
        existing.isDeleted
          ? 'Existe un producto eliminado con ese SKU. Recupérelo o use otro código.'
          : 'Ya existe un producto con ese SKU',
        { productId: existing.id },
      );
    }

    if (input.barcode) {
      const duplicate = await this.products.findByBarcode(input.barcode);
      if (duplicate) {
        throw new ConflictError(
          'PRODUCT_BARCODE_ALREADY_EXISTS',
          `El código de barras ya está asignado a ${duplicate.name}`,
          { productId: duplicate.id },
        );
      }
    }

    const product = Product.create({
      id: this.ids.generate(),
      tenantId: input.tenantId,
      sku: input.sku,
      name: input.name,
      price: Money.fromDecimal(input.price, input.currency),
      costPrice:
        input.costPrice === undefined
          ? undefined
          : Money.fromDecimal(input.costPrice, input.currency),
      categoryId: input.categoryId ?? null,
      barcode: input.barcode ?? null,
      description: input.description ?? null,
      brand: input.brand ?? null,
      taxRate: input.taxRate === undefined ? undefined : Percentage.create(input.taxRate),
      unit: input.unit,
      reorderPoint: input.reorderPoint,
      reorderQuantity: input.reorderQuantity,
      isRetail: input.isRetail,
      isInternal: input.isInternal,
      trackStock: input.trackStock,
      tracksBatches: input.tracksBatches,
      now: this.clock.now(),
      actorId: input.actorId,
    });

    const saved = await this.products.create(product);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'Product',
      entityId: saved.id,
      after: { sku: saved.sku, name: saved.name, price: saved.price.toDecimalString() },
    });

    return saved;
  }
}

// ---------------------------------------------------------------------------

export interface UpdateProductInput {
  readonly productId: string;
  readonly name?: string;
  readonly price?: string;
  readonly costPrice?: string;
  readonly categoryId?: string | null;
  readonly barcode?: string | null;
  readonly description?: string | null;
  readonly brand?: string | null;
  readonly taxRate?: number;
  readonly unit?: ProductUnitValue;
  readonly reorderPoint?: number;
  readonly reorderQuantity?: number;
  readonly isRetail?: boolean;
  readonly isInternal?: boolean;
  readonly isActive?: boolean;
  readonly trackStock?: boolean;
  readonly tracksBatches?: boolean;
  readonly actorId: string | null;
}

@Injectable()
export class UpdateProductUseCase implements UseCase<UpdateProductInput, Product> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: UpdateProductInput): Promise<Product> {
    const product = await this.products.findByIdOrFail(input.productId);
    const before = { name: product.name, price: product.price.toDecimalString() };

    if (input.barcode) {
      const duplicate = await this.products.findByBarcode(input.barcode);
      if (duplicate && duplicate.id !== product.id) {
        throw new ConflictError(
          'PRODUCT_BARCODE_ALREADY_EXISTS',
          `El código de barras ya está asignado a ${duplicate.name}`,
          { productId: duplicate.id },
        );
      }
    }

    const now = this.clock.now();
    const currency = product.price.currency;

    product.update(
      {
        name: input.name,
        description: input.description,
        brand: input.brand,
        barcode: input.barcode,
        categoryId: input.categoryId,
        price: input.price === undefined ? undefined : Money.fromDecimal(input.price, currency),
        taxRate: input.taxRate === undefined ? undefined : Percentage.create(input.taxRate),
        unit: input.unit,
        reorderPoint: input.reorderPoint,
        reorderQuantity: input.reorderQuantity,
        isRetail: input.isRetail,
        isInternal: input.isInternal,
        isActive: input.isActive,
        trackStock: input.trackStock,
        tracksBatches: input.tracksBatches,
      },
      now,
      input.actorId,
    );

    // Corregir el coste a mano es legítimo —un histórico mal migrado— pero no es una
    // edición cualquiera: cambia la valoración del almacén, así que va por su propia vía y
    // queda en la auditoría con nombre propio.
    if (input.costPrice !== undefined) {
      product.overrideCost(Money.fromDecimal(input.costPrice, currency), now, input.actorId);
    }

    const saved = await this.products.update(product);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'Product',
      entityId: saved.id,
      before,
      after: { name: saved.name, price: saved.price.toDecimalString() },
    });

    return saved;
  }
}

// ---------------------------------------------------------------------------

export interface SearchProductsInput {
  readonly filter: ProductFilter;
  readonly page: PageRequest<ProductSortField>;
}

@Injectable()
export class SearchProductsUseCase implements UseCase<SearchProductsInput, Page<Product>> {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository) {}

  execute(input: SearchProductsInput): Promise<Page<Product>> {
    return this.products.search(input.filter, input.page);
  }
}

@Injectable()
export class GetProductUseCase implements UseCase<{ productId: string }, Product> {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository) {}

  execute(input: { productId: string }): Promise<Product> {
    return this.products.findByIdOrFail(input.productId);
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class DeleteProductUseCase implements UseCase<
  { productId: string; actorId: string | null },
  void
> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: { productId: string; actorId: string | null }): Promise<void> {
    const product = await this.products.findByIdOrFail(input.productId);

    // La regla —no dar de baja con existencias— la aplica el agregado; aquí solo se
    // invoca. Ponerla en este caso de uso la dejaría fuera del alcance de cualquier otro
    // camino que borre un producto, que es como una invariante se convierte en opcional.
    product.markDeleted(this.clock.now(), input.actorId);
    await this.products.update(product);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'Product',
      entityId: product.id,
      before: { sku: product.sku, name: product.name },
    });
  }
}

@Injectable()
export class RestoreProductUseCase implements UseCase<
  { productId: string; actorId: string | null },
  Product
> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: { productId: string; actorId: string | null }): Promise<Product> {
    const restored = await this.products.restore(input.productId, input.actorId);

    await this.audit.record({
      action: 'RESTORE',
      entityType: 'Product',
      entityId: restored.id,
      after: { sku: restored.sku, name: restored.name },
    });

    return restored;
  }
}

// ===========================================================================
// Entradas de mercancía
// ===========================================================================

export interface ReceiveStockInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitCost: string;
  readonly currency?: string;
  readonly batchNumber?: string | null;
  readonly expiresAt?: Date | null;
  readonly supplierId?: string | null;
  readonly purchaseOrderId?: string | null;
  readonly notes?: string | null;
  readonly reason?: string | null;
  readonly actorId: string | null;
}

export interface ReceiveStockResult {
  readonly movement: InventoryMovement;
  readonly batch: Batch | null;
  readonly balanceAfter: number;
}

/**
 * Recepción de mercancía.
 *
 * Cuatro escrituras que tienen que ir juntas: el lote, las existencias, el coste medio y
 * el asiento del kardex. Que el stock suba y el movimiento no se registre deja un almacén
 * con unidades que ningún documento explica; que se registre el movimiento y el stock no
 * suba, un kardex que no cuadra con la estantería. Por eso todo va en la misma unidad de
 * trabajo.
 */
@Injectable()
export class ReceiveStockUseCase implements UseCase<ReceiveStockInput, ReceiveStockResult> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: ReceiveStockInput): Promise<ReceiveStockResult> {
    if (!(input.quantity > 0)) {
      throw new BusinessRuleViolationError(
        'INVALID_QUANTITY',
        'La cantidad recibida debe ser mayor que cero',
      );
    }

    const result = await this.uow.execute(async () => {
      const product = await this.products.findByIdOrFail(input.productId);
      const now = this.clock.now();
      const currency = input.currency ?? product.costPrice.currency;
      const unitCost = Money.fromDecimal(input.unitCost, currency);

      if (!product.trackStock) {
        throw new BusinessRuleViolationError(
          'PRODUCT_DOES_NOT_TRACK_STOCK',
          `El producto ${product.sku} no lleva control de existencias`,
          { productId: product.id },
        );
      }

      // El producto que se traza por lote no admite una entrada anónima: aceptarla dejaría
      // unidades sin lote que después ninguna salida FEFO sabría de dónde descontar, y la
      // trazabilidad tendría un agujero justo en el sitio donde se necesita.
      if (product.tracksBatches && !input.batchNumber) {
        throw new BusinessRuleViolationError(
          'BATCH_NUMBER_REQUIRED',
          `${product.name} se traza por lote: indique el número impreso en el envase`,
          { productId: product.id },
        );
      }

      const batch = input.batchNumber
        ? await this.receiveIntoBatch({ product, input, unitCost, now })
        : null;

      // El coste medio se recalcula antes de mover el stock: la media pondera con las
      // existencias que había (ADR-0011).
      product.applyReceiptCost(input.quantity, unitCost, now, input.actorId);

      const balanceAfter = await this.products.applyStockDelta(
        product.id,
        input.quantity,
        input.actorId,
      );

      // Guarda el coste medio recalculado. No pisa las existencias: `update` no escribe
      // `stockOnHand` justamente para que este agregado —leído antes del `applyStockDelta`
      // y por tanto desactualizado— no deshaga la suma atómica que se acaba de hacer.
      await this.products.update(product);

      const movement = await this.movements.append(
        InventoryMovement.record({
          id: this.ids.generate(),
          tenantId: input.tenantId,
          productId: product.id,
          type: 'PURCHASE_IN',
          quantityDelta: input.quantity,
          balanceAfter,
          unitCost,
          sourceType: input.purchaseOrderId ? 'PURCHASE_ORDER' : 'MANUAL',
          sourceId: input.purchaseOrderId ?? null,
          purchaseOrderId: input.purchaseOrderId ?? null,
          reason: input.reason ?? 'Recepción de mercancía',
          notes: input.notes ?? null,
          batchId: batch?.id ?? null,
          now,
          actorId: input.actorId,
        }),
      );

      return { movement, batch, balanceAfter };
    });

    await this.audit.record({
      action: 'CREATE',
      entityType: 'InventoryMovement',
      entityId: result.movement.id,
      after: {
        productId: input.productId,
        quantity: input.quantity,
        unitCost: input.unitCost,
        batchId: result.batch?.id ?? null,
        balanceAfter: result.balanceAfter,
      },
    });

    return result;
  }

  /**
   * Crea el lote o suma a uno existente con el mismo número.
   *
   * Recibir dos veces el mismo lote es corriente —llega partido en dos palés— y crear dos
   * filas lo rompería contra el índice único. Sumar al que hay solo es correcto si el
   * coste y la caducidad coinciden: con datos distintos no es el mismo lote, es un número
   * repetido, y eso hay que pararlo.
   */
  private async receiveIntoBatch(params: {
    product: Product;
    input: ReceiveStockInput;
    unitCost: Money;
    now: Date;
  }): Promise<Batch> {
    const { product, input, unitCost, now } = params;
    const batchNumber = input.batchNumber!;

    const existing = await this.batches.findByNumber(product.id, batchNumber);

    if (existing) {
      if (!existing.unitCost.equals(unitCost)) {
        throw new ConflictError(
          'BATCH_COST_MISMATCH',
          `El lote ${batchNumber} ya existe con un coste de ${existing.unitCost.toString()}`,
          { batchId: existing.id, existingCost: existing.unitCost.toDecimalString() },
        );
      }

      const existingExpiry = existing.expiresAt?.getTime() ?? null;
      const incomingExpiry = input.expiresAt?.getTime() ?? null;
      if (existingExpiry !== incomingExpiry) {
        throw new ConflictError(
          'BATCH_EXPIRY_MISMATCH',
          `El lote ${batchNumber} ya existe con otra fecha de caducidad`,
          { batchId: existing.id, existingExpiry: existing.expiresAt?.toISOString() ?? null },
        );
      }

      // Ampliar lo recibido: el lote crece en cantidad inicial y en restante a la vez,
      // porque lo que llega ahora no se ha consumido.
      existing.receiveMore(input.quantity, now, input.actorId);
      return this.batches.update(existing);
    }

    return this.batches.create(
      Batch.receive({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        productId: product.id,
        batchNumber,
        quantity: input.quantity,
        unitCost,
        expiresAt: input.expiresAt ?? null,
        supplierId: input.supplierId ?? null,
        purchaseOrderId: input.purchaseOrderId ?? null,
        notes: input.notes ?? null,
        now,
        actorId: input.actorId,
      }),
    );
  }
}

// ===========================================================================
// Salidas
// ===========================================================================

export interface ConsumeStockInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly type?: Extract<MovementTypeValue, 'SALE_OUT' | 'SERVICE_CONSUMPTION' | 'WASTE_OUT'>;
  readonly sourceType?: MovementSourceTypeValue;
  readonly sourceId?: string | null;
  readonly reason?: string | null;
  readonly notes?: string | null;
  /** Consumir de lotes caducados. Exige permiso y queda registrado (ADR-0012). */
  readonly allowExpired?: boolean;
  readonly actorId: string | null;
}

export interface ConsumeStockResult {
  readonly movements: readonly InventoryMovement[];
  readonly balanceAfter: number;
  /** Coste real de la salida, sumando el de cada lote consumido. */
  readonly totalCost: Money;
}

/**
 * Salida de existencias con reparto FEFO (ADR-0012).
 *
 * Es la pieza de la que depende el margen de cada servicio. El reparto se calcula primero
 * —sin tocar nada— y solo después se escribe, de modo que una salida imposible se rechaza
 * antes de haber consumido medio lote.
 *
 * Un producto sin seguimiento por lote sigue el camino corto: baja el stock y se valora al
 * coste medio. No es un caso degradado, es el correcto para un secador.
 */
@Injectable()
export class ConsumeStockUseCase implements UseCase<ConsumeStockInput, ConsumeStockResult> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: ConsumeStockInput): Promise<ConsumeStockResult> {
    if (!(input.quantity > 0)) {
      throw new BusinessRuleViolationError(
        'INVALID_QUANTITY',
        'La cantidad a consumir debe ser mayor que cero',
      );
    }

    const result = await this.uow.execute(async () => {
      const product = await this.products.findByIdOrFail(input.productId);
      const now = this.clock.now();
      const currency = product.costPrice.currency;
      const type = input.type ?? 'SERVICE_CONSUMPTION';

      if (!product.trackStock) {
        throw new BusinessRuleViolationError(
          'PRODUCT_DOES_NOT_TRACK_STOCK',
          `El producto ${product.sku} no lleva control de existencias`,
          { productId: product.id },
        );
      }

      if (!product.tracksBatches) {
        return this.consumeWithoutBatches({ product, input, type });
      }

      const available = await this.batches.findConsumable(product.id);
      const plan = StockAllocationService.allocate({
        batches: available,
        quantity: input.quantity,
        currency,
        now,
        allowExpired: input.allowExpired,
      });

      // Primero los lotes, después la caché. El orden importa: si el descuento de un lote
      // falla por concurrencia, el stock del producto no se ha tocado todavía y la
      // transacción revierte un estado coherente.
      for (const allocation of plan.allocations) {
        await this.batches.consume(allocation.batchId, allocation.quantity, input.actorId);
      }

      const balanceAfter = await this.products.applyStockDelta(
        product.id,
        -input.quantity,
        input.actorId,
      );

      // Un asiento por lote, no uno por salida. Es lo que permite responder «qué lote se le
      // aplicó a esta clienta» cuando hay una reacción, y lo que hace que el coste del
      // servicio sea el real y no una media (Reglamento (CE) 1223/2009).
      let running = round3(balanceAfter + input.quantity);
      const movements = plan.allocations.map((allocation) => {
        running = round3(running - allocation.quantity);
        return InventoryMovement.record({
          id: this.ids.generate(),
          tenantId: input.tenantId,
          productId: product.id,
          type,
          quantityDelta: -allocation.quantity,
          balanceAfter: running,
          unitCost: allocation.unitCost,
          sourceType: input.sourceType ?? 'MANUAL',
          sourceId: input.sourceId ?? null,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          batchId: allocation.batchId,
          now,
          actorId: input.actorId,
        });
      });

      return {
        movements: await this.movements.appendMany(movements),
        balanceAfter,
        totalCost: plan.totalCost,
      };
    });

    await this.audit.record({
      action: 'CREATE',
      entityType: 'InventoryMovement',
      entityId: result.movements[0]?.id ?? null,
      after: {
        productId: input.productId,
        quantity: -input.quantity,
        batches: result.movements.map((movement) => movement.batchId).filter(Boolean),
        totalCost: result.totalCost.toDecimalString(),
        balanceAfter: result.balanceAfter,
      },
    });

    return result;
  }

  private async consumeWithoutBatches(params: {
    product: Product;
    input: ConsumeStockInput;
    type: MovementTypeValue;
  }): Promise<ConsumeStockResult> {
    const { product, input, type } = params;
    const now = this.clock.now();

    const balanceAfter = await this.products.applyStockDelta(
      product.id,
      -input.quantity,
      input.actorId,
    );

    const movement = await this.movements.append(
      InventoryMovement.record({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        productId: product.id,
        type,
        quantityDelta: -input.quantity,
        balanceAfter,
        unitCost: product.costPrice,
        sourceType: input.sourceType ?? 'MANUAL',
        sourceId: input.sourceId ?? null,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        now,
        actorId: input.actorId,
      }),
    );

    return {
      movements: [movement],
      balanceAfter,
      // Sin lotes no hay coste real que consultar: se valora al medio ponderado, que es
      // para lo que ese campo sigue existiendo (ADR-0011).
      totalCost: product.costPrice.multiply(input.quantity),
    };
  }
}

// ===========================================================================
// Ajustes
// ===========================================================================

export interface AdjustStockInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly quantityDelta: number;
  readonly reason: string;
  readonly type?: MovementTypeValue;
  readonly batchId?: string | null;
  readonly notes?: string | null;
  readonly allowExpired?: boolean;
  readonly actorId: string | null;
}

export interface AdjustStockResult {
  readonly movements: readonly InventoryMovement[];
  readonly balanceAfter: number;
}

/**
 * Ajuste por recuento o merma.
 *
 * Reparte el trabajo en tres caminos según lo que se esté pidiendo, y esa bifurcación es
 * la que evita duplicar el motor:
 *
 * - **Lote concreto**: la encargada ha contado ese lote. Se toca solo ese.
 * - **Salida de un producto con lotes**: no se sabe de cuál sale, así que decide FEFO. Se
 *   delega en `ConsumeStockUseCase` en vez de reimplementarlo, que es como el reparto
 *   acabaría teniendo dos versiones que divergen (ADR-0002).
 * - **Resto**: variación directa sobre la caché, atómica.
 */
@Injectable()
export class AdjustStockUseCase implements UseCase<AdjustStockInput, AdjustStockResult> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    private readonly consumeStock: ConsumeStockUseCase,
  ) {}

  async execute(input: AdjustStockInput): Promise<AdjustStockResult> {
    if (input.quantityDelta === 0 || !Number.isFinite(input.quantityDelta)) {
      throw new BusinessRuleViolationError('INVALID_QUANTITY', 'El ajuste no puede ser de cero');
    }

    const product = await this.products.findByIdOrFail(input.productId);

    if (!product.trackStock) {
      throw new BusinessRuleViolationError(
        'PRODUCT_DOES_NOT_TRACK_STOCK',
        `El producto ${product.sku} no lleva control de existencias`,
        { productId: product.id },
      );
    }

    if (!input.batchId && input.quantityDelta < 0 && product.tracksBatches) {
      const consumed = await this.consumeStock.execute({
        tenantId: input.tenantId,
        productId: input.productId,
        quantity: Math.abs(input.quantityDelta),
        type: input.type === 'WASTE_OUT' ? 'WASTE_OUT' : 'SERVICE_CONSUMPTION',
        sourceType: 'STOCK_COUNT',
        reason: input.reason,
        notes: input.notes ?? null,
        allowExpired: input.allowExpired,
        actorId: input.actorId,
      });
      return { movements: consumed.movements, balanceAfter: consumed.balanceAfter };
    }

    // Una entrada por ajuste en un producto con lotes no tiene a qué lote ir. Inventarle
    // uno sería peor que rechazarla: pareceria trazabilidad sin serlo. La vía correcta es
    // registrar la entrada como recepción, con su número de lote.
    if (!input.batchId && input.quantityDelta > 0 && product.tracksBatches) {
      throw new BusinessRuleViolationError(
        'BATCH_REQUIRED_FOR_INBOUND_ADJUSTMENT',
        `${product.name} se traza por lote: registre la entrada como recepción o indique el lote a corregir`,
        { productId: product.id },
      );
    }

    const result = await this.uow.execute(async () => {
      const now = this.clock.now();
      let batchNumber: string | null = null;

      if (input.batchId) {
        const batch = await this.batches.findByIdOrFail(input.batchId);

        if (batch.productId !== product.id) {
          throw new BusinessRuleViolationError(
            'BATCH_PRODUCT_MISMATCH',
            'El lote indicado no pertenece a ese producto',
            { batchId: batch.id, productId: product.id },
          );
        }

        batchNumber = batch.batchNumber;

        if (input.quantityDelta < 0) {
          await this.batches.consume(batch.id, Math.abs(input.quantityDelta), input.actorId);
        } else {
          await this.batches.restock(batch.id, input.quantityDelta, input.actorId);
        }
      }

      const balanceAfter = await this.products.applyStockDelta(
        product.id,
        input.quantityDelta,
        input.actorId,
      );

      const movement = await this.movements.append(
        InventoryMovement.record({
          id: this.ids.generate(),
          tenantId: input.tenantId,
          productId: product.id,
          type: input.type ?? 'ADJUSTMENT',
          quantityDelta: input.quantityDelta,
          balanceAfter,
          // Se valora al coste medio: un ajuste no viene de una compra, así que no hay un
          // coste real que consultar. Con lote sí lo hay, y manda el del lote.
          unitCost: product.costPrice,
          sourceType: 'STOCK_COUNT',
          reason: input.reason,
          notes: input.notes ?? null,
          batchId: input.batchId ?? null,
          now,
          actorId: input.actorId,
        }),
      );

      return { movements: [movement], balanceAfter, batchNumber };
    });

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'InventoryMovement',
      entityId: result.movements[0].id,
      after: {
        productId: input.productId,
        quantityDelta: input.quantityDelta,
        reason: input.reason,
        batchNumber: result.batchNumber,
        balanceAfter: result.balanceAfter,
      },
    });

    return { movements: result.movements, balanceAfter: result.balanceAfter };
  }
}

// ===========================================================================
// Consultas
// ===========================================================================

/** Un asiento del kardex con lo necesario para leerlo sin más consultas. */
export interface KardexEntry {
  readonly movement: InventoryMovement;
  readonly product: Product | null;
  readonly batch: Batch | null;
}

/**
 * Kardex legible.
 *
 * El movimiento por sí solo no se puede pintar: guarda identificadores, y quien lo consulta
 * necesita el nombre del producto y el número de lote. Se resuelve con **dos consultas por
 * página** —una de productos y otra de lotes, por lote de identificadores— en lugar de una
 * por fila, que es el N+1 clásico de esta pantalla: doscientos movimientos son
 * cuatrocientas consultas y una tabla que tarda segundos en aparecer.
 */
@Injectable()
export class GetKardexUseCase implements UseCase<
  { filter: MovementFilter; page: PageRequest<MovementSortField> },
  Page<KardexEntry>
> {
  constructor(
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
  ) {}

  async execute(input: {
    filter: MovementFilter;
    page: PageRequest<MovementSortField>;
  }): Promise<Page<KardexEntry>> {
    const page = await this.movements.search(input.filter, input.page);

    const productIds = unique(page.data.map((movement) => movement.productId));
    const batchIds = unique(
      page.data.map((movement) => movement.batchId).filter((id): id is string => id !== null),
    );

    const [products, batches] = await Promise.all([
      this.products.findManyByIds(productIds),
      this.batches.findManyByIds(batchIds),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));

    return {
      data: page.data.map((movement) => ({
        movement,
        product: productById.get(movement.productId) ?? null,
        batch: movement.batchId ? (batchById.get(movement.batchId) ?? null) : null,
      })),
      meta: page.meta,
    };
  }
}

// ---------------------------------------------------------------------------

export interface BatchListing {
  readonly batch: Batch;
  readonly product: Product | null;
}

@Injectable()
export class SearchBatchesUseCase implements UseCase<
  { filter: BatchFilter; page: PageRequest<BatchSortField> },
  Page<BatchListing>
> {
  constructor(
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
  ) {}

  async execute(input: {
    filter: BatchFilter;
    page: PageRequest<BatchSortField>;
  }): Promise<Page<BatchListing>> {
    const page = await this.batches.search(input.filter, input.page);

    const products = await this.products.findManyByIds(
      unique(page.data.map((batch) => batch.productId)),
    );
    const productById = new Map(products.map((product) => [product.id, product]));

    return {
      data: page.data.map((batch) => ({
        batch,
        product: productById.get(batch.productId) ?? null,
      })),
      meta: page.meta,
    };
  }
}

// ---------------------------------------------------------------------------

export interface StockAlerts {
  /** Productos en o por debajo del punto de pedido. */
  readonly reorder: readonly {
    readonly product: Product;
    readonly missing: number;
    readonly suggestedOrder: number;
  }[];
  /** Lotes que caducan dentro del plazo, del más urgente al menos. */
  readonly expiring: readonly { readonly batch: Batch; readonly daysLeft: number | null }[];
  /** Lotes ya caducados: existencias que están en la estantería y no se pueden usar. */
  readonly expired: readonly Batch[];
}

/**
 * Panel de avisos del inventario.
 *
 * Junta las dos preguntas que se hacen a diario —qué hay que pedir y qué se va a estropear—
 * en una sola respuesta, porque se miran a la vez y pedirlas por separado significaría dos
 * viajes para pintar la misma pantalla.
 */
@Injectable()
export class GetStockAlertsUseCase implements UseCase<{ withinDays?: number }, StockAlerts> {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(BATCH_REPOSITORY) private readonly batches: BatchRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: { withinDays?: number }): Promise<StockAlerts> {
    const now = this.clock.now();
    const withinDays = input.withinDays ?? 30;

    const [lowStock, expiringBatches] = await Promise.all([
      this.products.findBelowReorderPoint(),
      this.batches.findExpiringWithin(withinDays, now),
    ]);

    const expired = expiringBatches.filter((batch) => batch.isExpired(now));
    const expiring = expiringBatches
      .filter((batch) => !batch.isExpired(now))
      .map((batch) => ({ batch, daysLeft: batch.daysUntilExpiry(now) }));

    return {
      reorder: lowStock.map((product) => ({
        product,
        missing: product.missingToReorderPoint,
        // Se sugiere lo que el salón haya fijado como pedido habitual; si no lo ha fijado,
        // al menos lo que falta para volver al mínimo. Sugerir cero no ayuda a nadie.
        suggestedOrder:
          product.reorderQuantity > 0 ? product.reorderQuantity : product.missingToReorderPoint,
      })),
      expiring,
      expired,
    };
  }
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const unique = (values: readonly string[]): string[] => [...new Set(values)];
