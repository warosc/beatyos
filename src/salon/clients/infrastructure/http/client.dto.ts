import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { Client } from '../../domain/client.entity';

const GENDERS = ['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED'] as const;
const STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateClientDto {
  @ApiProperty({ example: 'Rosa', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName!: string;

  @ApiProperty({ example: 'Iglesias', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName!: string;

  @ApiPropertyOptional({
    example: 'rosa@ejemplo.es',
    description:
      'Obligatorio si no se indica teléfono: sin vía de contacto no se puede avisar de un cambio de cita.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'Introduzca un correo electrónico válido' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || null : value,
  )
  email?: string | null;

  @ApiPropertyOptional({
    example: '+34600111222',
    description: 'Obligatorio si no se indica correo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  phone?: string | null;

  @ApiPropertyOptional({ example: '1988-04-17', format: 'date' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  birthDate?: Date | null;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsEnum(GENDERS)
  gender?: (typeof GENDERS)[number] | null;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Preferencias, historial de color, observaciones.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({
    maxLength: 1000,
    description:
      'Alergias y sensibilidades. Campo crítico: se consulta antes de aplicar cualquier ' +
      'producto químico. Se muestra destacado en la ficha.',
    example: 'Alergia a la parafenilendiamina (PPD)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  allergies?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine?: string | null;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  postalCode?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'Consentimiento explícito para comunicaciones comerciales (RGPD). Al activarlo se ' +
      'sella la fecha, que es la prueba de que se obtuvo.',
  })
  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;
}

/**
 * Modificación parcial.
 *
 * No usa `PartialType(CreateClientDto)` a propósito: heredarlo haría opcionales también
 * `firstName` y `lastName`, y con `exactOptionalPropertyTypes` desactivado se perdería la
 * distinción entre "no se envía el campo" y "se envía null para vaciarlo". Esa diferencia
 * importa aquí: vaciar el correo de una clienta y no tocarlo son operaciones distintas.
 */
export class UpdateClientDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Envíe `null` para vaciar el campo.' })
  @IsOptional()
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || null : value,
  )
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  birthDate?: Date | null;

  @ApiPropertyOptional({ enum: GENDERS, nullable: true })
  @IsOptional()
  @IsEnum(GENDERS)
  gender?: (typeof GENDERS)[number] | null;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  allergies?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ maxLength: 10, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  postalCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;
}

export class AnonymizeClientDto {
  @ApiProperty({
    description:
      'Motivo de la solicitud de supresión. Se registra en auditoría: es la prueba de que ' +
      'el derecho se atendió y de por qué.',
    example: 'Solicitud de la interesada por correo del 2026-09-01',
  })
  @IsString()
  @MinLength(10, { message: 'Describa el motivo con al menos 10 caracteres' })
  @MaxLength(500)
  reason!: string;
}

export class ClientQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Busca en nombre, apellidos, correo y teléfono' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  search?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsEnum(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({
    description: 'Solo quienes aceptan (o rechazan) comunicaciones comerciales',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  marketingConsent?: boolean;

  @ApiPropertyOptional({ example: 'Madrid' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    description: 'Sin visitas desde esta fecha. Incluye a quien nunca ha venido.',
    format: 'date-time',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  inactiveSince?: Date;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 365,
    description: 'Cumpleaños en los próximos N días',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  birthdayWithinDays?: number;
}

// ---------------------------------------------------------------------------
// Respuesta
// ---------------------------------------------------------------------------

export class ClientResponse {
  @ApiProperty() id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true, format: 'date' }) birthDate!: string | null;
  @ApiProperty({ nullable: true, description: 'Edad en años cumplidos' }) age!: number | null;
  @ApiProperty({ enum: GENDERS, nullable: true }) gender!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true, description: 'Consultar SIEMPRE antes de aplicar químicos' })
  allergies!: string | null;
  @ApiProperty({ nullable: true }) addressLine!: string | null;
  @ApiProperty({ nullable: true }) city!: string | null;
  @ApiProperty({ nullable: true }) postalCode!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty() marketingConsent!: boolean;
  @ApiProperty({ nullable: true, format: 'date-time' }) marketingConsentAt!: string | null;
  @ApiProperty() loyaltyPoints!: number;
  @ApiProperty() totalVisits!: number;

  @ApiProperty({
    example: '345.50',
    description:
      'Importe acumulado como **cadena decimal**, no como número: `JSON.parse` lo ' +
      'convertiría a coma flotante binaria y dejaría de sumar exacto (ADR-0010).',
  })
  totalSpent!: string;

  @ApiProperty({ example: 'GTQ' }) currency!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) lastVisitAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    description: 'Solo si se pidió incluir eliminados',
  })
  deletedAt?: string | null;

  /**
   * Traduce el agregado a la respuesta pública.
   *
   * Que exista este mapeo, en vez de serializar la entidad, es lo que permite cambiar la
   * forma interna del dominio sin romper a ningún cliente de la API. También es lo que
   * garantiza que nunca se escape un campo que no debería salir.
   */
  static from(client: Client, now: Date): ClientResponse {
    return {
      id: client.id,
      firstName: client.name.firstName,
      lastName: client.name.lastName,
      fullName: client.name.full,
      email: client.email?.value ?? null,
      phone: client.phone?.value ?? null,
      birthDate: client.birthDate?.toISOString().slice(0, 10) ?? null,
      age: client.ageAt(now),
      gender: client.gender,
      notes: client.notes,
      allergies: client.allergies,
      addressLine: client.addressLine,
      city: client.city,
      postalCode: client.postalCode,
      status: client.status,
      marketingConsent: client.marketingConsent,
      marketingConsentAt: client.marketingConsentAt?.toISOString() ?? null,
      loyaltyPoints: client.loyaltyPoints,
      totalVisits: client.totalVisits,
      totalSpent: client.totalSpent.toDecimalString(),
      currency: client.totalSpent.currency,
      lastVisitAt: client.lastVisitAt?.toISOString() ?? null,
      createdAt: client.audit.createdAt.toISOString(),
      updatedAt: client.audit.updatedAt.toISOString(),
      ...(client.audit.deletedAt ? { deletedAt: client.audit.deletedAt.toISOString() } : {}),
    };
  }
}
