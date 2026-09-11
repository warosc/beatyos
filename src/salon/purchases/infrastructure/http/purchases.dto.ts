import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PurchaseOrderStatus, SupplierStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../../shared/infrastructure/http/dto/pagination.dto';

/**
 * DTOs del borde HTTP de compras.
 *
 * Estaban dentro del controlador, uno por línea. Sacarlos no es cosmética: el
 * `ValidationPipe` global funciona con `whitelist` y `forbidNonWhitelisted`, así que estas
 * clases **son** el contrato de entrada —un campo no declarado aquí es un 400— y merecen
 * poder leerse.
 *
 * Validan **forma**; las invariantes de negocio las comprueba el dominio (ADR-0001). Por
 * eso aquí hay longitudes máximas y número de decimales, y no reglas como «no se puede
 * recibir más de lo pedido».
 */

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export class CreateSupplierDto {
  @IsString() @MaxLength(40) code!: string;
  @IsString() @MaxLength(150) name!: string;
  @IsOptional() @IsString() @MaxLength(150) legalName?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) paymentTermDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** El código no se admite: identifica al proveedor en los albaranes ya emitidos. */
export class UpdateSupplierDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(150) legalName?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) paymentTermDays?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsEnum(SupplierStatus) status?: SupplierStatus;
}

export class ListSuppliersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(150) search?: string;
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

export class PurchaseLineDto {
  @IsString() productId!: string;
  /** Tres decimales: la misma rejilla que declara el esquema para las cantidades. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantity!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitCost!: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class CreatePurchaseOrderDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsISO8601() expectedAt?: string;
  @IsOptional() @IsString() @MaxLength(100) supplierReference?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines!: PurchaseLineDto[];
}

export class CancelPurchaseOrderDto {
  @IsString() @MaxLength(250) reason!: string;
}

export class ReceiptLineDto {
  @IsString() lineId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantity!: number;
  @IsOptional() @IsString() @MaxLength(100) batchNumber?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class ReceivePurchaseOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  lines!: ReceiptLineDto[];
}

export class ListPurchaseOrdersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(PurchaseOrderStatus) status?: PurchaseOrderStatus;
}
