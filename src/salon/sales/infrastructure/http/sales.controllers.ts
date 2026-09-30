import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { InvoiceStatus, PaymentMethod } from '@prisma/client';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { WILDCARD_PERMISSION } from '../../../../shared/domain/authorization';
import { ForbiddenActionError } from '../../../../shared/domain/errors';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  GetInvoiceUseCase,
  RegisterSaleUseCase,
  SearchInvoicesUseCase,
  SummarizeSalesUseCase,
  VoidInvoiceUseCase,
} from '../../application/sales.use-cases';
import {
  InvoiceEnvelopeResponse,
  InvoicePageResponse,
  SalesSummaryEnvelopeResponse,
  toInvoiceResponse,
  toSalesSummaryResponse,
} from './sales.response';

/**
 * Adaptador HTTP de ventas.
 *
 * El cuerpo de `POST /sales` y la forma de la respuesta se conservan: el punto de venta de
 * `apps/web` envía `lines` y `payments` con los mismos nombres y lee `number` del resultado.
 * Lo que ha cambiado está debajo —dinero exacto, descuento de stock por FEFO y numeración
 * sin huecos—.
 */

class SaleLineDto {
  @ApiProperty({ enum: ['PRODUCT', 'SERVICE'] })
  @IsIn(['PRODUCT', 'SERVICE'])
  kind!: 'PRODUCT' | 'SERVICE';

  @ApiProperty() @IsUUID() itemId!: string;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional() @IsOptional() @IsUUID() stylistId?: string;

  @ApiPropertyOptional({ example: 5, description: 'Descuento en importe sobre la línea' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountAmount?: number;
}

class SalePaymentDto {
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method!: PaymentMethod;

  @ApiProperty({ example: 45.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) reference?: string;
}

export class CreateSaleDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() clientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() appointmentId?: string;

  @ApiProperty({ type: [SaleLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines!: SaleLineDto[];

  @ApiProperty({ type: [SalePaymentDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class VoidInvoiceDto {
  @ApiProperty({ example: 'Cobrada por error a la clienta equivocada' })
  @IsString()
  @MinLength(3)
  @MaxLength(250)
  reason!: string;
}

export class InvoiceQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() clientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() stylistId?: string;

  @ApiPropertyOptional({ enum: InvoiceStatus })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional({ enum: PaymentMethod, description: 'Cobradas con este método' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 100, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SalesSummaryQueryDto {
  @ApiProperty({ example: '2026-09-29T06:00:00.000Z' }) @IsISO8601() from!: string;
  @ApiProperty({ example: '2026-09-30T05:59:59.999Z' }) @IsISO8601() to!: string;
}

// ---------------------------------------------------------------------------

@ApiTags('Ventas y facturación')
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  private readonly currency: string;

  constructor(
    private readonly searchInvoices: SearchInvoicesUseCase,
    private readonly getInvoice: GetInvoiceUseCase,
    private readonly registerSale: RegisterSaleUseCase,
    private readonly voidInvoice: VoidInvoiceUseCase,
    private readonly summarizeSales: SummarizeSalesUseCase,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  @Get()
  @RequirePermissions(PERMISSIONS.invoices.read)
  @ApiOperation({ operationId: 'sales_list', summary: 'Buscar facturas' })
  @ApiOkResponse({ type: InvoicePageResponse })
  async list(@Query() query: InvoiceQueryDto) {
    const { page, payments, names } = await this.searchInvoices.execute({
      filter: {
        search: query.search,
        clientId: query.clientId,
        stylistId: query.stylistId,
        status: query.status,
        method: query.method,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? 100 },
    });

    return {
      data: page.data.map((invoice) =>
        toInvoiceResponse(
          invoice,
          payments.filter((payment) => payment.invoiceId === invoice.id),
          names,
        ),
      ),
      meta: page.meta,
    };
  }

  // Antes de `:id`: si no, «summary» se tomaría por un identificador.
  @Get('summary')
  @RequirePermissions(PERMISSIONS.invoices.read)
  @ApiOperation({
    operationId: 'sales_summary',
    summary: 'Cuadre de un periodo: lo facturado y, por método, lo cobrado y lo devuelto',
  })
  @ApiOkResponse({ type: SalesSummaryEnvelopeResponse })
  async summary(@Query() query: SalesSummaryQueryDto) {
    const summary = await this.summarizeSales.execute({
      from: new Date(query.from),
      to: new Date(query.to),
    });
    return toSalesSummaryResponse(summary, this.currency);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.invoices.read)
  @ApiOperation({ operationId: 'sales_get', summary: 'Consultar una factura, con sus cobros' })
  @ApiOkResponse({ type: InvoiceEnvelopeResponse })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const { invoice, payments, names } = await this.getInvoice.execute({ invoiceId: id });
    return toInvoiceResponse(invoice, payments, names);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.invoices.create, PERMISSIONS.payments.create)
  @ApiOperation({
    operationId: 'sales_create',
    summary: 'Registra una venta: emite la factura, cobra y descuenta existencias por FEFO',
    description: 'Si alguna línea lleva descuento, exige además el permiso invoices.discount.',
  })
  @ApiCreatedResponse({ type: InvoiceEnvelopeResponse })
  async create(@Body() dto: CreateSaleDto, @CurrentUser() user: AccessTokenClaims) {
    assertMayDiscount(dto, user);

    const { invoice, payments } = await this.registerSale.execute({
      tenantId: requireTenant(user),
      currency: this.currency,
      clientId: dto.clientId ?? null,
      appointmentId: dto.appointmentId ?? null,
      notes: dto.notes ?? null,
      lines: dto.lines.map((line) => ({
        kind: line.kind,
        itemId: line.itemId,
        quantity: line.quantity,
        stylistId: line.stylistId ?? null,
        // El importe cruza como cadena decimal a partir de aquí: es donde se convierte el
        // número que llega por JSON, y desde este punto ya es `Money` (ADR-0010).
        discountAmount: line.discountAmount?.toFixed(2),
      })),
      payments: dto.payments.map((payment) => ({
        method: payment.method,
        amount: payment.amount.toFixed(2),
        reference: payment.reference ?? null,
      })),
      actorId: user.sub,
    });

    return toInvoiceResponse(invoice, payments);
  }

  @Post(':id/void')
  @RequirePermissions(PERMISSIONS.invoices.void)
  @ApiOperation({
    operationId: 'sales_void',
    summary: 'Anula una venta devolviendo sus cobros y su género (ADR-0020)',
    description:
      'El efectivo sale de la caja abierta: sin caja abierta no se anula una venta cobrada en ' +
      'efectivo. Los cobros con tarjeta o transferencia quedan devueltos y se reembolsan por su ' +
      'medio. El stock vuelve a los mismos lotes.',
  })
  @ApiCreatedResponse({ type: InvoiceEnvelopeResponse })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const { invoice, payments } = await this.voidInvoice.execute({
      invoiceId: id,
      reason: dto.reason,
      actorId: user.sub,
    });

    return toInvoiceResponse(invoice, payments);
  }
}

// ---------------------------------------------------------------------------

/**
 * Un descuento exige `invoices.discount` además de poder facturar.
 *
 * Es un permiso condicionado al cuerpo —la misma venta sin descuento es legítima para
 * recepción—, así que no cabe en `@RequirePermissions`, que solo mira la ruta.
 */
const assertMayDiscount = (dto: CreateSaleDto, user: AccessTokenClaims): void => {
  const discounts = dto.lines.some((line) => (line.discountAmount ?? 0) > 0);
  if (!discounts) return;

  const allowed =
    user.permissions.includes(WILDCARD_PERMISSION) ||
    user.permissions.includes(PERMISSIONS.invoices.discount);
  if (!allowed) {
    throw new ForbiddenActionError(
      PERMISSIONS.invoices.discount,
      'Solo la encargada o la propietaria pueden aplicar descuentos',
    );
  }
};

const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError('sales.create', 'Facturar requiere estar asignado a un salón');
  }
  return user.tenantId;
};
