import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import { PageMetaResponse } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type {
  PurchaseOrderSortField,
  SupplierSortField,
} from '../../domain/purchases.repositories';
import {
  CancelPurchaseOrderUseCase,
  CreatePurchaseOrderUseCase,
  GetPurchaseOrderUseCase,
  ListPurchaseOrdersUseCase,
  ReceivePurchaseOrderUseCase,
  SubmitPurchaseOrderUseCase,
} from '../../application/purchase-order.use-cases';
import {
  CreateSupplierUseCase,
  DeleteSupplierUseCase,
  ListSuppliersUseCase,
  RestoreSupplierUseCase,
  UpdateSupplierUseCase,
} from '../../application/supplier.use-cases';
import {
  CancelPurchaseOrderDto,
  CreatePurchaseOrderDto,
  CreateSupplierDto,
  ListPurchaseOrdersQueryDto,
  ListSuppliersQueryDto,
  ReceivePurchaseOrderDto,
  UpdateSupplierDto,
} from './purchases.dto';
import {
  EmptyEnvelopeResponse,
  PurchaseOrderEnvelopeResponse,
  PurchaseOrderPageResponse,
  SupplierEnvelopeResponse,
  SupplierPageResponse,
  toPurchaseOrderResponse,
  toSupplierResponse,
  type PurchaseOrderResponse,
  type SupplierResponse,
} from './purchases.response';

/**
 * Borde HTTP de compras (ADR-0017).
 *
 * Los controladores no deciden nada: validan la forma con el DTO, llaman a un caso de uso
 * y presentan el resultado. Toda la lógica que antes vivía aquí y en el servicio está en el
 * dominio y en la aplicación, donde se puede probar sin levantar un servidor.
 *
 * El `tenantId` sale del claim del token y de ningún otro sitio (ADR-0003).
 */

@Controller({ path: 'suppliers', version: '1' })
@ApiTags('Proveedores')
export class SuppliersController {
  constructor(
    private readonly list: ListSuppliersUseCase,
    private readonly create: CreateSupplierUseCase,
    private readonly update: UpdateSupplierUseCase,
    private readonly remove: DeleteSupplierUseCase,
    private readonly restoreSupplier: RestoreSupplierUseCase,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'suppliers_list', summary: 'Listar proveedores' })
  @ApiOkResponse({ type: SupplierPageResponse })
  @RequirePermissions(PERMISSIONS.suppliers.read)
  async search(
    @Query() query: ListSuppliersQueryDto,
  ): Promise<{ data: SupplierResponse[]; meta: PageMetaResponse }> {
    const page = await this.list.execute({
      filter: { search: query.search },
      page: query.toPageRequest<SupplierSortField>(),
    });
    return { data: page.data.map((supplier) => toSupplierResponse(supplier)), meta: page.meta };
  }

  @Post()
  @ApiOperation({ operationId: 'suppliers_create', summary: 'Crear proveedor' })
  @ApiCreatedResponse({ type: SupplierEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.suppliers.create)
  async add(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<SupplierResponse> {
    const supplier = await this.create.execute({
      ...dto,
      tenantId: user.tenantId!,
      actorId: user.sub,
    });
    return toSupplierResponse(supplier);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'suppliers_update', summary: 'Actualizar proveedor' })
  @ApiOkResponse({ type: SupplierEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.suppliers.update)
  async edit(
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<SupplierResponse> {
    const supplier = await this.update.execute({
      supplierId: id,
      changes: dto,
      actorId: user.sub,
    });
    return toSupplierResponse(supplier);
  }

  @Delete(':id')
  @ApiOperation({ operationId: 'suppliers_delete', summary: 'Eliminar proveedor' })
  @ApiOkResponse({ type: EmptyEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.suppliers.delete)
  async drop(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims): Promise<void> {
    await this.remove.execute({ supplierId: id, actorId: user.sub });
  }

  @Post(':id/restore')
  @ApiOperation({ operationId: 'suppliers_restore', summary: 'Restaurar proveedor' })
  @ApiCreatedResponse({ type: SupplierEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.suppliers.restore)
  async restore(
    @Param('id') id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<SupplierResponse> {
    const supplier = await this.restoreSupplier.execute({ supplierId: id, actorId: user.sub });
    return toSupplierResponse(supplier);
  }
}

// ---------------------------------------------------------------------------

@Controller({ path: 'purchases', version: '1' })
@ApiTags('Compras')
export class PurchasesController {
  constructor(
    private readonly list: ListPurchaseOrdersUseCase,
    private readonly get: GetPurchaseOrderUseCase,
    private readonly create: CreatePurchaseOrderUseCase,
    private readonly submit: SubmitPurchaseOrderUseCase,
    private readonly receive: ReceivePurchaseOrderUseCase,
    private readonly cancel: CancelPurchaseOrderUseCase,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'purchases_list', summary: 'Listar órdenes de compra' })
  @ApiOkResponse({ type: PurchaseOrderPageResponse })
  @RequirePermissions(PERMISSIONS.purchases.read)
  async search(
    @Query() query: ListPurchaseOrdersQueryDto,
  ): Promise<{ data: PurchaseOrderResponse[]; meta: PageMetaResponse }> {
    const page = await this.list.execute({
      filter: { status: query.status },
      page: query.toPageRequest<PurchaseOrderSortField>(),
    });
    return {
      data: page.data.map((view) => toPurchaseOrderResponse(view, { withMovements: false })),
      meta: page.meta,
    };
  }

  @Get(':id')
  @ApiOperation({ operationId: 'purchases_get', summary: 'Consultar una orden de compra' })
  @ApiOkResponse({ type: PurchaseOrderEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.purchases.read)
  async detail(@Param('id') id: string): Promise<PurchaseOrderResponse> {
    return toPurchaseOrderResponse(await this.get.execute({ orderId: id }), {
      withMovements: true,
    });
  }

  @Post()
  @ApiOperation({ operationId: 'purchases_create', summary: 'Crear una orden de compra' })
  @ApiCreatedResponse({ type: PurchaseOrderEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.purchases.create)
  async add(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<PurchaseOrderResponse> {
    const view = await this.create.execute({
      ...dto,
      tenantId: user.tenantId!,
      actorId: user.sub,
    });
    return toPurchaseOrderResponse(view, { withMovements: false });
  }

  @Post(':id/submit')
  @ApiOperation({ operationId: 'purchases_submit', summary: 'Enviar una orden de compra' })
  @ApiCreatedResponse({ type: PurchaseOrderEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.purchases.submit)
  async send(
    @Param('id') id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<PurchaseOrderResponse> {
    const view = await this.submit.execute({ orderId: id, actorId: user.sub });
    return toPurchaseOrderResponse(view, { withMovements: true });
  }

  @Post(':id/receive')
  @ApiOperation({ operationId: 'purchases_receive', summary: 'Registrar una recepción' })
  @ApiCreatedResponse({ type: PurchaseOrderEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.purchases.receive)
  async accept(
    @Param('id') id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<PurchaseOrderResponse> {
    const view = await this.receive.execute({
      orderId: id,
      tenantId: user.tenantId!,
      lines: dto.lines,
      actorId: user.sub,
    });
    return toPurchaseOrderResponse(view, { withMovements: true });
  }

  @Post(':id/cancel')
  @ApiOperation({ operationId: 'purchases_cancel', summary: 'Cancelar una orden de compra' })
  @ApiCreatedResponse({ type: PurchaseOrderEnvelopeResponse })
  @RequirePermissions(PERMISSIONS.purchases.cancel)
  async abort(
    @Param('id') id: string,
    @Body() dto: CancelPurchaseOrderDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<PurchaseOrderResponse> {
    const view = await this.cancel.execute({
      orderId: id,
      reason: dto.reason,
      actorId: user.sub,
    });
    return toPurchaseOrderResponse(view, { withMovements: true });
  }
}
