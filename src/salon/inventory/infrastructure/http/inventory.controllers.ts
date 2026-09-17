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
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

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
} from '../../application/inventory.use-cases';
import type { StockStatus } from '../../domain/product.entity';
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
import {
  AdjustStockEnvelopeResponse,
  BatchPageResponse,
  ConsumeStockEnvelopeResponse,
  KardexPageResponse,
  ProductEnvelopeResponse,
  ProductPageResponse,
  ReceiveStockEnvelopeResponse,
  StockAlertsEnvelopeResponse,
  toBatchListingResponse,
  toBatchResponse,
  toKardexEntryResponse,
  toMovementResponse,
  toProductResponse,
  toStockAlertsResponse,
} from './inventory.response';

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
  @ApiOperation({
    operationId: 'products_list',
    summary: 'Lista el catálogo con su semáforo de existencias',
  })
  @ApiOkResponse({ type: ProductPageResponse })
  async list(@Query() query: ProductQueryDto, @CurrentUser() user: AccessTokenClaims) {
    const page = await this.searchProducts.execute({
      filter: {
        search: query.search,
        categoryId: query.categoryId,
        stock: query.stock ? STOCK_BY_QUERY[query.stock] : undefined,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? DEFAULT_LIMIT },
    });

    return presentPage(page, (product) => toProductResponse(product, canSeeCosts(user)));
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.products.read)
  @ApiOperation({ operationId: 'products_get', summary: 'Consultar un producto' })
  @ApiOkResponse({ type: ProductEnvelopeResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    const product = await this.getProduct.execute({ productId: id });
    return toProductResponse(product, canSeeCosts(user));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.products.create)
  @ApiOperation({ operationId: 'products_create', summary: 'Crear un producto' })
  @ApiCreatedResponse({ type: ProductEnvelopeResponse })
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

    return toProductResponse(product, canSeeCosts(user));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.products.update)
  @ApiOperation({ operationId: 'products_update', summary: 'Actualizar un producto' })
  @ApiOkResponse({ type: ProductEnvelopeResponse })
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

    return toProductResponse(product, canSeeCosts(user));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.products.delete)
  @ApiOperation({
    operationId: 'products_delete',
    summary: 'Da de baja un producto. Exige que no queden existencias',
  })
  @ApiNoContentResponse()
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    await this.deleteProduct.execute({ productId: id, actorId: user.sub });
  }

  @Post(':id/restore')
  @RequirePermissions(PERMISSIONS.products.restore)
  @ApiOperation({ operationId: 'products_restore', summary: 'Restaurar un producto dado de baja' })
  @ApiCreatedResponse({ type: ProductEnvelopeResponse })
  async restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    const product = await this.restoreProduct.execute({ productId: id, actorId: user.sub });
    return toProductResponse(product, canSeeCosts(user));
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
  @ApiOperation({
    operationId: 'inventory_kardex',
    summary: 'Libro de movimientos. Es la fuente de verdad del inventario',
  })
  @ApiOkResponse({ type: KardexPageResponse })
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

    return presentPage(page, toKardexEntryResponse);
  }

  @Get('batches')
  @RequirePermissions(PERMISSIONS.inventory.read)
  @ApiOperation({ operationId: 'inventory_batches', summary: 'Lista los lotes por producto' })
  @ApiOkResponse({ type: BatchPageResponse })
  async batches(@Query() query: BatchQueryDto) {
    const page = await this.searchBatches.execute({
      filter: {
        productId: query.productId,
        search: query.search,
        onlyAvailable: query.onlyAvailable,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? DEFAULT_LIMIT },
    });

    return presentPage(page, toBatchListingResponse);
  }

  @Get('alerts')
  @RequirePermissions(PERMISSIONS.inventory.read)
  @ApiOperation({
    operationId: 'inventory_alerts',
    summary: 'Qué hay que pedir y qué está a punto de caducar',
  })
  @ApiOkResponse({ type: StockAlertsEnvelopeResponse })
  async alerts(@Query() query: StockAlertsQueryDto) {
    return toStockAlertsResponse(await this.stockAlerts.execute({ withinDays: query.withinDays }));
  }

  @Post('receive')
  @RequirePermissions(PERMISSIONS.inventory.receive)
  @ApiOperation({
    operationId: 'inventory_receive',
    summary: 'Registra una entrada de mercancía, con lote si el producto lo lleva',
  })
  @ApiCreatedResponse({ type: ReceiveStockEnvelopeResponse })
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
      ...toMovementResponse(result.movement),
      batch: result.batch ? toBatchResponse(result.batch) : null,
      balanceAfter: result.balanceAfter.toFixed(3),
    };
  }

  @Post('consume')
  @RequirePermissions(PERMISSIONS.inventory.adjust)
  @ApiOperation({
    operationId: 'inventory_consume',
    summary: 'Descuenta existencias repartiendo por FEFO entre los lotes disponibles',
  })
  @ApiCreatedResponse({ type: ConsumeStockEnvelopeResponse })
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
      movements: result.movements.map(toMovementResponse),
      balanceAfter: result.balanceAfter.toFixed(3),
      totalCost: result.totalCost.toDecimalString(),
      currency: result.totalCost.currency,
    };
  }

  @Post('adjust')
  @RequirePermissions(PERMISSIONS.inventory.adjust)
  @ApiOperation({
    operationId: 'inventory_adjust',
    summary: 'Ajusta existencias por recuento o merma',
  })
  @ApiCreatedResponse({ type: AdjustStockEnvelopeResponse })
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
      ...toMovementResponse(result.movements[0]),
      movements: result.movements.map(toMovementResponse),
      balanceAfter: result.balanceAfter.toFixed(3),
    };
  }
}

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
