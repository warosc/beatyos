import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsHexColor,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { Category } from '../../domain/category.entity';
import type { Service } from '../../domain/service.entity';

const KINDS = ['SERVICE', 'PRODUCT'] as const;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Importe decimal en cadena. Nunca número (ADR-0010). */
const DECIMAL = /^\d{1,10}(\.\d{1,2})?$/;

// ===========================================================================
// Servicios
// ===========================================================================

export class CreateServiceDto {
  @ApiProperty({ example: 'COR-M', description: 'Código corto y único dentro del salón' })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/, {
    message: 'El código admite de 2 a 20 letras, dígitos o guiones',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  code!: string;

  @ApiProperty({ example: 'Corte de señora' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trim)
  name!: string;

  @ApiProperty({
    minimum: 1,
    maximum: 480,
    description: 'Tiempo dedicado a la clienta. Es lo que se cobra.',
    example: 45,
  })
  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes!: number;

  @ApiProperty({
    example: '25.00',
    description:
      'Precio **sin** impuestos, como cadena decimal. Nunca como número: `JSON.parse` lo ' +
      'convertiría a coma flotante y dejaría de sumar exacto (ADR-0010).',
  })
  @IsString()
  @Matches(DECIMAL, { message: 'El precio debe ser una cadena decimal, p. ej. "25.00"' })
  price!: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 120,
    default: 0,
    description:
      'Margen posterior de limpieza y preparación. **Bloquea agenda pero no se factura.** ' +
      'Sin él, el salón encadena citas sin respiro y acumula retraso durante toda la tarde.',
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    default: 12,
    example: 12,
    description:
      'IVA de Guatemala. Cada servicio guarda el suyo: si el tipo cambia por ley, los documentos ya emitidos conservan el que se les aplicó.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description: 'Comisión propia del servicio. Sin indicar, manda la del profesional.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionRate?: number | null;

  @ApiPropertyOptional({
    default: true,
    description: 'Reservable por la clienta desde fuera, frente a solo agendable por el salón',
  })
  @IsOptional()
  @IsBoolean()
  isBookableOnline?: boolean;

  @ApiPropertyOptional({ example: '#8B5CF6' })
  @IsOptional()
  @IsHexColor()
  color?: string | null;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateServiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 480 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional({
    example: '30.00',
    description: 'Cadena decimal. No cambia las citas ya agendadas.',
  })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL)
  price?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionRate?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isBookableOnline?: boolean;

  @ApiPropertyOptional({ description: 'Retirar del catálogo sin borrar el histórico' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string | null;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ConsumableDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    example: 0.15,
    description: 'Cantidad en la unidad del producto. Admite fracciones.',
  })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
}

export class SetConsumablesDto {
  @ApiProperty({
    type: [ConsumableDto],
    description:
      'Escandallo: qué productos consume el servicio. **Reemplaza** la lista anterior. ' +
      'Alimenta los movimientos de inventario al completar la cita y el margen real del servicio.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ConsumableDto)
  consumables!: ConsumableDto[];
}

export class ServiceQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Busca en nombre, código y descripción' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Solo los reservables online' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  bookableOnline?: boolean;

  @ApiPropertyOptional({ description: 'Servicios que caben en el hueco disponible', example: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxDurationMinutes?: number;
}

export class ServiceResponse {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) categoryId!: string | null;

  @ApiProperty({ description: 'Tiempo dedicado a la clienta', example: 45 })
  durationMinutes!: number;

  @ApiProperty({ description: 'Margen de limpieza posterior; no se factura', example: 10 })
  bufferMinutes!: number;

  @ApiProperty({
    description:
      'Hueco que ocupa en el calendario: atención más margen. Es el número que usa la agenda.',
    example: 55,
  })
  blockedMinutes!: number;

  @ApiProperty({ example: '25.00', description: 'Precio sin impuestos, como cadena decimal' })
  price!: string;

  @ApiProperty({ example: '5.25' }) taxAmount!: string;
  @ApiProperty({ example: '30.25', description: 'Precio final que ve la clienta' })
  priceWithTax!: string;

  @ApiProperty({ example: 'GTQ' }) currency!: string;
  @ApiProperty({ example: 21 }) taxRate!: number;
  @ApiProperty({ nullable: true }) commissionRate!: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ description: 'Admite reservas nuevas' }) isBookable!: boolean;
  @ApiProperty() isBookableOnline!: boolean;
  @ApiProperty({ nullable: true }) color!: string | null;
  @ApiProperty() sortOrder!: number;

  @ApiProperty({ description: 'Escandallo de productos que consume' })
  consumables!: { productId: string; quantity: number }[];

  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) deletedAt?: string | null;

  static from(service: Service): ServiceResponse {
    return {
      id: service.id,
      code: service.code,
      name: service.name,
      description: service.description,
      categoryId: service.categoryId,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      blockedMinutes: service.blockedMinutes,
      price: service.price.toDecimalString(),
      taxAmount: service.taxAmount.toDecimalString(),
      priceWithTax: service.priceWithTax.toDecimalString(),
      currency: service.price.currency,
      taxRate: service.taxRate.value,
      commissionRate: service.commissionRate?.value ?? null,
      isActive: service.isActive,
      isBookable: service.isBookable(),
      isBookableOnline: service.isBookableOnline,
      color: service.color,
      sortOrder: service.sortOrder,
      consumables: service.consumables.map((item) => ({ ...item })),
      createdAt: service.audit.createdAt.toISOString(),
      updatedAt: service.audit.updatedAt.toISOString(),
      ...(service.audit.deletedAt ? { deletedAt: service.audit.deletedAt.toISOString() } : {}),
    };
  }
}

// ===========================================================================
// Categorías
// ===========================================================================

export class CreateCategoryDto {
  @ApiProperty({
    enum: KINDS,
    description: 'Una categoría es de servicios o de productos, nunca de ambos',
  })
  @IsEnum(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiProperty({ example: 'Peluquería' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(trim)
  name!: string;

  @ApiPropertyOptional({
    description: 'Identificador para URL. Se genera del nombre si no se indica.',
    example: 'peluqueria',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ example: '#8B5CF6' })
  @IsOptional()
  @IsHexColor()
  color?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'Categoría madre. Máximo 3 niveles.' })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(trim)
  name?: string;

  @ApiPropertyOptional({
    description: 'Renombrar NO cambia el slug: puede estar en una URL pública.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'Envíe `null` para convertirla en raíz' })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CategoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsEnum(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ description: 'Busca en nombre, slug y descripción' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  isActive?: boolean;
}

export class CategoryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: KINDS }) kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) color!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) parentId!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static from(category: Category): CategoryResponse {
    return {
      id: category.id,
      kind: category.kind,
      name: category.name,
      slug: category.slug,
      description: category.description,
      color: category.color,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      createdAt: category.audit.createdAt.toISOString(),
      updatedAt: category.audit.updatedAt.toISOString(),
    };
  }
}
