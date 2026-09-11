import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
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
  ValidateNested,
} from 'class-validator';
import { InvoiceStatus, PaymentMethod } from '@prisma/client';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { ForbiddenActionError } from '../../../../shared/domain/errors';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  GetInvoiceUseCase,
  RegisterSaleUseCase,
  SearchInvoicesUseCase,
  VoidInvoiceUseCase,
} from '../../application/sales.use-cases';
import type { Invoice } from '../../domain/invoice.entity';
import type { Payment } from '../../domain/payment.entity';

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
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  @Get()
  @RequirePermissions(PERMISSIONS.invoices.read)
  async list(@Query() query: InvoiceQueryDto) {
    const page = await this.searchInvoices.execute({
      filter: {
        search: query.search,
        clientId: query.clientId,
        stylistId: query.stylistId,
        status: query.status,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      page: { page: query.page ?? 1, limit: query.limit ?? 100 },
    });

    return { data: page.data.map((invoice) => presentInvoice(invoice)), meta: page.meta };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.invoices.read)
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const { invoice, payments } = await this.getInvoice.execute({ invoiceId: id });
    return presentInvoice(invoice, payments);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.invoices.create, PERMISSIONS.payments.create)
  @ApiOperation({
    summary: 'Registra una venta: emite la factura, cobra y descuenta existencias por FEFO',
  })
  async create(@Body() dto: CreateSaleDto, @CurrentUser() user: AccessTokenClaims) {
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

    return presentInvoice(invoice, payments);
  }

  @Post(':id/void')
  @RequirePermissions(PERMISSIONS.invoices.void)
  @ApiOperation({ summary: 'Anula una factura. Exige que no tenga cobros' })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const invoice = await this.voidInvoice.execute({
      invoiceId: id,
      reason: dto.reason,
      actorId: user.sub,
    });

    return presentInvoice(invoice);
  }
}

// ---------------------------------------------------------------------------

/**
 * Factura serializada.
 *
 * Los importes salen como **cadena decimal**: un `numeric` de PostgreSQL no cabe exacto en
 * un `number` de JavaScript, y serializarlo como número tiraría por la ventana la
 * exactitud que se mantiene en toda la pila (ADR-0010).
 */
const presentInvoice = (invoice: Invoice, payments?: readonly Payment[]) => ({
  id: invoice.id,
  number: invoice.number,
  status: invoice.status,
  clientId: invoice.clientId,
  appointmentId: invoice.appointmentId,
  issuedAt: invoice.issuedAt,
  dueAt: invoice.dueAt,
  paidAt: invoice.paidAt,
  voidedAt: invoice.voidedAt,
  voidReason: invoice.voidReason,
  subtotal: invoice.subtotal.toDecimalString(),
  discountTotal: invoice.discountTotal.toDecimalString(),
  taxTotal: invoice.taxTotal.toDecimalString(),
  total: invoice.total.toDecimalString(),
  paidTotal: invoice.paidTotal.toDecimalString(),
  balanceDue: invoice.balanceDue.toDecimalString(),
  commissionTotal: invoice.commissionTotal.toDecimalString(),
  currency: invoice.currency,
  notes: invoice.notes,
  lines: invoice.lines.map((line) => ({
    id: line.id,
    kind: line.kind,
    productId: line.productId,
    serviceId: line.serviceId,
    stylistId: line.stylistId,
    description: line.description,
    quantity: line.quantity.toFixed(3),
    unitPrice: line.unitPrice.toDecimalString(),
    discountAmount: line.discountAmount.toDecimalString(),
    taxRate: line.taxRate.value.toFixed(2),
    taxAmount: line.taxAmount.toDecimalString(),
    lineSubtotal: line.lineSubtotal.toDecimalString(),
    lineTotal: line.lineTotal.toDecimalString(),
    commissionAmount: line.commissionAmount.toDecimalString(),
  })),
  ...(payments
    ? {
        payments: payments.map((payment) => ({
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amount: payment.amount.toDecimalString(),
          refundedAmount: payment.refundedAmount.toDecimalString(),
          currency: payment.amount.currency,
          reference: payment.reference,
          receivedAt: payment.receivedAt,
        })),
      }
    : {}),
});

const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError('sales.create', 'Facturar requiere estar asignado a un salón');
  }
  return user.tenantId;
};
