import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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
} from 'class-validator';

import { MovementType, ProductUnit } from '@prisma/client';

import { BooleanParam } from '../../../../shared/infrastructure/http/boolean-param.decorator';

/**
 * DTOs de inventario.
 *
 * Los nombres de campo y los tipos se conservan **exactamente** como los tenía la versión
 * anterior del módulo: el motor de dentro se ha reemplazado entero, pero `apps/web` sigue
 * enviando lo mismo y recibiendo lo mismo. Un cambio de contrato aquí habría convertido una
 * corrección interna en una migración del frontend.
 */

const STOCK_STATUSES = ['available', 'low', 'out'] as const;
export type StockQueryValue = (typeof STOCK_STATUSES)[number];

export class ProductQueryDto {
  @ApiPropertyOptional({ description: 'Busca en nombre, SKU, código de barras y marca' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: STOCK_STATUSES, description: 'Semáforo de existencias' })
  @IsOptional()
  @IsIn(STOCK_STATUSES)
  stock?: StockQueryValue;

  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 200, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class CreateProductDto {
  @ApiProperty({ example: 'SH-ARG-500' }) @IsString() @MaxLength(50) sku!: string;
  @ApiProperty({ example: 'Champú de argán 500 ml' }) @IsString() @MaxLength(160) name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;

  @ApiProperty({ example: 120.5 }) @Type(() => Number) @IsNumber() @Min(0) price!: number;

  @ApiPropertyOptional({ example: 65 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'IVA aplicable. Por defecto, el 12 % de Guatemala',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reorderPoint?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reorderQuantity?: number;

  @ApiPropertyOptional({ enum: ProductUnit }) @IsOptional() @IsEnum(ProductUnit) unit?: ProductUnit;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isRetail?: boolean;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isInternal?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() trackStock?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Trazabilidad por lote y caducidad. Obligatoria en cosmética con caducidad',
  })
  @IsOptional()
  @IsBoolean()
  tracksBatches?: boolean;
}

export class UpdateProductDto extends CreateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) declare sku: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) declare name: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  declare price: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ReceiveStockDto {
  @ApiProperty() @IsUUID() productId!: string;

  @ApiProperty({ example: 12 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;

  @ApiProperty({ example: 65.4 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost!: number;

  @ApiPropertyOptional({
    description: 'Número impreso en el envase. Obligatorio si el producto se traza por lote',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  batchNumber?: string;

  @ApiPropertyOptional({ example: '2027-04-30' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class AdjustStockDto {
  @ApiProperty() @IsUUID() productId!: string;

  @ApiProperty({ example: -1.5, description: 'Variación con signo. Nunca cero' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  quantityDelta!: number;

  @ApiPropertyOptional({ enum: MovementType })
  @IsOptional()
  @IsEnum(MovementType)
  type?: MovementType;

  @ApiProperty({ example: 'Recuento físico de marzo' })
  @IsString()
  @MaxLength(250)
  reason!: string;

  @ApiPropertyOptional({ description: 'Lote concreto. Si se omite en una salida, decide FEFO' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ConsumeStockDto {
  @ApiProperty() @IsUUID() productId!: string;

  @ApiProperty({ example: 2.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional({ enum: ['SALE_OUT', 'SERVICE_CONSUMPTION', 'WASTE_OUT'] })
  @IsOptional()
  @IsIn(['SALE_OUT', 'SERVICE_CONSUMPTION', 'WASTE_OUT'])
  type?: 'SALE_OUT' | 'SERVICE_CONSUMPTION' | 'WASTE_OUT';

  @ApiPropertyOptional({ description: 'Cita o factura que origina el consumo' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(250) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Consumir de lotes caducados. Requiere inventory.adjust y queda auditado',
  })
  @IsOptional()
  @IsBoolean()
  allowExpired?: boolean;
}

export class KardexQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() batchId?: string;

  @ApiPropertyOptional({ enum: MovementType })
  @IsOptional()
  @IsEnum(MovementType)
  type?: MovementType;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 200, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class BatchQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) search?: string;

  @ApiPropertyOptional({ description: 'Solo lotes con existencias' })
  @BooleanParam()
  onlyAvailable?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 200, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class StockAlertsQueryDto {
  @ApiPropertyOptional({ default: 30, description: 'Ventana de caducidad, en días' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  withinDays?: number;
}
