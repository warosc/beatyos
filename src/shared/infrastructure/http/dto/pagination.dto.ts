import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import type { PageMeta, SortCriterion } from '../../../domain/ports/repository.port';

/**
 * Parámetros de listado comunes a todos los recursos (ADR-0007).
 *
 * Se hereda de esta clase en cada filtro concreto, de modo que la paginación y la
 * ordenación se declaran, validan y documentan una sola vez.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Página a devolver, empezando en 1',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero' })
  @Min(1, { message: 'page empieza en 1' })
  page: number = 1;

  @ApiPropertyOptional({
    description:
      'Elementos por página. El máximo de 100 es deliberado: sin tope, un cliente podría ' +
      'pedir la tabla entera y tumbar el servicio sin necesidad de un ataque.',
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un número entero' })
  @Min(1)
  @Max(100, { message: 'limit no puede superar 100 elementos por página' })
  limit: number = 20;

  @ApiPropertyOptional({
    description:
      'Ordenación como `campo:dirección`, separando por comas para ordenar por varios. ' +
      'Los campos admitidos dependen del recurso y se validan contra una lista blanca.',
    example: 'createdAt:desc,name:asc',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_.]*:(asc|desc)(,[a-zA-Z][a-zA-Z0-9_.]*:(asc|desc))*$/, {
    message: 'sort debe seguir el formato campo:asc|desc, separado por comas',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  sort?: string;

  @ApiPropertyOptional({
    description:
      'Incluye los registros eliminados (soft delete). Requiere el permiso `*.restore` ' +
      'del recurso; sin él se ignora silenciosamente.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  includeDeleted: boolean = false;

  /** Convierte `sort` en criterios tipados. El repositorio los valida contra su lista. */
  toSortCriteria<TField extends string = string>(): SortCriterion<TField>[] {
    if (!this.sort) return [];
    return this.sort.split(',').map((chunk) => {
      const [field, direction] = chunk.split(':');
      return { field: field as TField, direction: direction as 'asc' | 'desc' };
    });
  }

  toPageRequest<TField extends string = string>() {
    return {
      page: this.page,
      limit: this.limit,
      sort: this.toSortCriteria<TField>(),
    };
  }
}

/** Metadatos de paginación devueltos en cada colección. */
export class PageMetaResponse implements PageMeta {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 137, description: 'Total de elementos que cumplen el filtro' })
  total!: number;
  @ApiProperty({ example: 7 }) totalPages!: number;
  @ApiProperty({ example: true }) hasNext!: boolean;
  @ApiProperty({ example: false }) hasPrevious!: boolean;
}

/** Filtro por rango de fechas, reutilizable en agenda, caja e informes. */
export class DateRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Inicio del rango, en ISO 8601. Inclusivo.',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  from?: Date;

  @ApiPropertyOptional({
    description: 'Fin del rango, en ISO 8601. Inclusivo.',
    example: '2026-09-30T23:59:59.999Z',
  })
  @IsOptional()
  @Type(() => Date)
  to?: Date;
}
