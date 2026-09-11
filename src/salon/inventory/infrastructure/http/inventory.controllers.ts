import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { WILDCARD_PERMISSION } from '../../../../shared/domain/authorization';
import { ForbiddenActionError } from '../../../../shared/domain/errors';
import type { Page } from '../../../../shared/domain/ports/repository.port';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
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
  type BatchListing,
  type KardexEntry,
  type StockAlerts,
} from '../../application/inventory.use-cases';
import type { Batch } from '../../domain/batch.entity';
import type { InventoryMovement } from '../../domain/inventory-movement.entity';
import type { Product, StockStatus } from '../../domain/product.entity';
import {
  AdjustStockDto,
  BatchQueryDto,
  ConsumeStockDto,
  CreateProductDto,
  KardexQueryDto,
  ProductQueryDto,
  ReceiveStockDto,
  StockAlertsQueryDto,
  UpdateProductDto,
  type StockQueryValue,
} from './inventory.dto';

/**
 * Adaptador HTTP del inventario.
 *
 * Las rutas, los nombres de campo y el formato de cada respuesta son **los mismos** que
 * antes de la reconciliación: `apps/web` no se ha tocado. Lo que ha cambiado está debajo —
 * el reparto FEFO, el dinero exacto y el descuento atómico de existencias—, y eso es
 * precisamente lo que un adaptador bien puesto permite: sustituir el motor sin que el
 * consumidor se entere.
 *
 * Los presentadores viven aquí, al final del archivo, y no en los casos de uso. Un caso de
 * uso que devuelve cadenas con dos decimales ya está decidiendo cómo se pinta algo, y esa
 * decisión pertenece a la frontera (ADR-0001).
 */

const DEFAULT_LIMIT = 200;

/** El semáforo llega en minúsculas desde la interfaz y el dominio lo usa en mayúsculas. */
const STOCK_BY_QUERY: Readonly<Record<StockQueryValue, StockStatus>> = {
  available: 'AVAILABLE',
  low: 'LOW',
  out: 'OUT',
};

@ApiTags('Productos')
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  /** Moneda de operación del salón. Nunca se codifica: se lee de la configuración. */
  private readonly currency: string;

  constructor(
    private readonly searchProducts: SearchProductsUseCase,
    private readonly getProduct: GetProductUseCase,
    private readonly createProduct: CreateProductUseCase,
    private readonly updateProduct: UpdateProductUseCase,
    private readonly deleteProduct: DeleteProductUseCase,
    private readonly restoreProduct: RestoreProductUseCase,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  @Get()
  @RequirePermissions(PERMISSIONS.products.read)
  @ApiOperation({ summary: 'Lista el catálogo con su semáforo de existencias' })
  async list(@Query() query: ProductQueryDto, @CurrentUser() user: AccessTokenClaims) {
    const page = await this.searchProducts.execute({
      filter: {
        search: query.search,
        categoryId: query.categoryId,
        stock: query.stock ? STOCK_BY_QUERY[query.stock] : undefined,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? DEFAULT_LIMIT },
    });

    return presentPage(page, (product) => presentProduct(product, canSeeCosts(user)));
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.products.read)
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    const product = await this.getProduct.execute({ productId: id });
    return presentProduct(product, canSeeCosts(user));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.products.create)
  async create(@Body() dto: CreateProductDto, @CurrentUser() user: AccessTokenClaims) {
    const product = await this.createProduct.execute({
      tenantId: requireTenant(user),
      sku: dto.sku,
      name: dto.name,
      // El importe cruza como cadena decimal desde aquí hacia dentro: es donde se convierte
      // el número que llega por JSON, y a partir de este punto ya es `Money` (ADR-0010).
      price: toDecimalString(dto.price, 2),
      currency: this.currency,
      costPrice: dto.costPrice === undefined ? undefined : toDecimalString(dto.costPrice, 2),
      categoryId: dto.categoryId ?? null,
      barcode: dto.barcode ?? null,
      description: dto.description ?? null,
      brand: dto.brand ?? null,
      taxRate: dto.taxRate,
      unit: dto.unit,
      reorderPoint: dto.reorderPoint,
      reorderQuantity: dto.reorderQuantity,
      isRetail: dto.isRetail,
      isInternal: dto.isInternal,
      trackStock: dto.trackStock,
      tracksBatches: dto.tracksBatches,
      actorId: user.sub,
    });

    return presentProduct(product, canSeeCosts(user));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.products.update)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    // Cambiar el coste altera la valoración del almacén, así que exige el permiso que
    // gobierna los costes y no basta con poder editar el producto.
    if (dto.costPrice !== undefined && !canSeeCosts(user)) {
      throw new ForbiddenActionError(
        'products.update-cost',
        'Modificar el coste requiere el permiso de costes y márgenes',
      );
    }

    const product = await this.updateProduct.execute({
      productId: id,
      name: dto.name,
      price: dto.price === undefined ? undefined : toDecimalString(dto.price, 2),
      costPrice: dto.costPrice === undefined ? undefined : toDecimalString(dto.costPrice, 2),
      categoryId: dto.categoryId,
      barcode: dto.barcode,
      description: dto.description,
      brand: dto.brand,
      taxRate: dto.taxRate,
      unit: dto.unit,
      reorderPoint: dto.reorderPoint,
      reorderQuantity: dto.reorderQuantity,
      isRetail: dto.isRetail,
      isInternal: dto.isInternal,
      isActive: dto.isActive,
      trackStock: dto.trackStock,
      tracksBatches: dto.tracksBatches,
      actorId: user.sub,
    });

    return presentProduct(product, canSeeCosts(user));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.products.delete)
  @ApiOperation({ summary: 'Da de baja un producto. Exige que no queden existencias' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    await this.deleteProduct.execute({ productId: id, actorId: user.sub });
  }

  @Post(':id/restore')
  @RequirePermissions(PERMISSIONS.products.restore)
  async restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    const product = await this.restoreProduct.execute({ productId: id, actorId: user.sub });
    return presentProduct(product, canSeeCosts(user));
  }
}

// ---------------------------------------------------------------------------

@ApiTags('Inventario')
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(
    private readonly getKardex: GetKardexUseCase,
    private readonly searchBatches: SearchBatchesUseCase,
    private readonly receiveStock: ReceiveStockUseCase,
    private readonly consumeStock: ConsumeStockUseCase,
    private readonly adjustStock: AdjustStockUseCase,
    private readonly stockAlerts: GetStockAlertsUseCase,
  ) {}

  @Get('kardex')
  @RequirePermissions(PERMISSIONS.inventory.read)
  @ApiOperation({ summary: 'Libro de movimientos. Es la fuente de verdad del inventario' })
  async kardex(@Query() query: KardexQueryDto) {
    const page = await this.getKardex.execute({
      filter: {
        productId: query.productId,
        batchId: query.batchId,
        type: query.type,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? DEFAULT_LIMIT },
    });

    return presentPage(page, presentKardexEntry);
  }

  @Get('batches')
  @RequirePermissions(PERMISSIONS.inventory.read)
  async batches(@Query() query: BatchQueryDto) {
    const page = await this.searchBatches.execute({
      filter: {
        productId: query.productId,
        search: query.search,
        onlyAvailable: query.onlyAvailable,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? DEFAULT_LIMIT },
    });

    return presentPage(page, presentBatchListing);
  }

  @Get('alerts')
  @RequirePermissions(PERMISSIONS.inventory.read)
  @ApiOperation({ summary: 'Qué hay que pedir y qué está a punto de caducar' })
  @ApiOkResponse({ description: 'Reposición pendiente y lotes próximos a caducar' })
  async alerts(@Query() query: StockAlertsQueryDto) {
    return presentAlerts(await this.stockAlerts.execute({ withinDays: query.withinDays }));
  }

  @Post('receive')
  @RequirePermissions(PERMISSIONS.inventory.receive)
  @ApiOperation({ summary: 'Registra una entrada de mercancía, con lote si el producto lo lleva' })
  async receive(@Body() dto: ReceiveStockDto, @CurrentUser() user: AccessTokenClaims) {
    const result = await this.receiveStock.execute({
      tenantId: requireTenant(user),
      productId: dto.productId,
      quantity: dto.quantity,
      unitCost: toDecimalString(dto.unitCost, 2),
      batchNumber: dto.batchNumber ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      supplierId: dto.supplierId ?? null,
      notes: dto.notes ?? null,
      actorId: user.sub,
    });

    return {
      ...presentMovement(result.movement),
      batch: result.batch ? presentBatch(result.batch) : null,
      balanceAfter: result.balanceAfter.toFixed(3),
    };
  }

  @Post('consume')
  @RequirePermissions(PERMISSIONS.inventory.adjust)
  @ApiOperation({
    summary: 'Descuenta existencias repartiendo por FEFO entre los lotes disponibles',
  })
  async consume(@Body() dto: ConsumeStockDto, @CurrentUser() user: AccessTokenClaims) {
    const result = await this.consumeStock.execute({
      tenantId: requireTenant(user),
      productId: dto.productId,
      quantity: dto.quantity,
      type: dto.type,
      sourceId: dto.sourceId ?? null,
      reason: dto.reason ?? null,
      notes: dto.notes ?? null,
      allowExpired: dto.allowExpired,
      actorId: user.sub,
    });

    return {
      movements: result.movements.map(presentMovement),
      balanceAfter: result.balanceAfter.toFixed(3),
      totalCost: result.totalCost.toDecimalString(),
      currency: result.totalCost.currency,
    };
  }

  @Post('adjust')
  @RequirePermissions(PERMISSIONS.inventory.adjust)
  @ApiOperation({ summary: 'Ajusta existencias por recuento o merma' })
  async adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: AccessTokenClaims) {
    const result = await this.adjustStock.execute({
      tenantId: requireTenant(user),
      productId: dto.productId,
      quantityDelta: dto.quantityDelta,
      reason: dto.reason,
      type: dto.type,
      batchId: dto.batchId ?? null,
      notes: dto.notes ?? null,
      actorId: user.sub,
    });

    // La respuesta conserva la forma antigua —un movimiento— y añade el resto cuando el
    // ajuste se repartió por FEFO entre varios lotes. Devolver de golpe una lista donde
    // antes había un objeto habría roto el frontend sin necesidad.
    return {
      ...presentMovement(result.movements[0]),
      movements: result.movements.map(presentMovement),
      balanceAfter: result.balanceAfter.toFixed(3),
    };
  }
}

// ===========================================================================
// Presentadores
// ===========================================================================

/**
 * Producto tal y como lo espera `apps/web`.
 *
 * Las cantidades salen con tres decimales y los importes con dos, siempre como **cadena**:
 * un `numeric` de PostgreSQL no cabe exacto en un `number` de JavaScript, y serializarlo
 * como número sería tirar por la ventana la exactitud que se mantiene en toda la pila
 * (ADR-0010).
 *
 * `costPrice` se omite —no se pone a `null`— cuando quien consulta no tiene el permiso de
 * costes: un `null` afirma que no hay coste, y aquí lo cierto es que no se puede ver.
 */
const presentProduct = (product: Product, includeCosts: boolean) => ({
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

const presentMovement = (movement: InventoryMovement) => ({
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

const presentKardexEntry = (entry: KardexEntry) => ({
  ...presentMovement(entry.movement),
  // La tabla del kardex muestra el nombre del producto y el número de lote. Van anidados
  // con la misma forma que tenían cuando esto era un `include` de Prisma.
  product: entry.product ? { sku: entry.product.sku, name: entry.product.name } : null,
  batch: entry.batch ? { batchNumber: entry.batch.batchNumber } : null,
});

const presentBatch = (batch: Batch) => ({
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

const presentBatchListing = (listing: BatchListing) => ({
  ...presentBatch(listing.batch),
  product: listing.product ? { sku: listing.product.sku, name: listing.product.name } : null,
});

const presentAlerts = (alerts: StockAlerts) => ({
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
    ...presentBatch(item.batch),
    daysLeft: item.daysLeft,
  })),
  expired: alerts.expired.map(presentBatch),
});

// ===========================================================================
// Auxiliares
// ===========================================================================

const presentPage = <TIn, TOut>(page: Page<TIn>, present: (item: TIn) => TOut) => ({
  data: page.data.map(present),
  meta: page.meta,
});

/**
 * Convierte el número que llega por JSON en la cadena decimal que espera `Money`.
 *
 * `toFixed` y no `String(value)`: `0.1 + 0.2` llega como `0.30000000000000004` desde
 * cualquier cliente que haya hecho una suma, y `Money.fromDecimal` lo rechazaría por tener
 * más precisión de la representable. Aquí es donde se decide, una sola vez y de forma
 * visible, que un importe se redondea a los decimales de la moneda.
 */
const toDecimalString = (value: number, decimals: number): string => value.toFixed(decimals);

const canSeeCosts = (user: AccessTokenClaims): boolean =>
  user.permissions.includes(PERMISSIONS.products.readCost) ||
  user.permissions.includes(WILDCARD_PERMISSION);

/**
 * El `tenantId` sale del token, nunca del cuerpo de la petición.
 *
 * Un usuario de plataforma sin salón asignado no puede dar de alta productos: no habría
 * inquilino al que pertenecieran. Es un fallo de autorización, no de validación.
 */
const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError(
      'inventory.write',
      'Esta operación requiere estar asignado a un salón',
    );
  }
  return user.tenantId;
};
