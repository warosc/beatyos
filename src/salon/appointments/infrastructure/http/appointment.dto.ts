import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PaginationQueryDto } from '../../../../shared/infrastructure/http/dto/pagination.dto';
import type { Appointment } from '../../domain/appointment.entity';

const STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
const SOURCES = ['WALK_IN', 'PHONE', 'ONLINE', 'STAFF'] as const;

export class ScheduleAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stylistId!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Instante de inicio en ISO 8601. La duración se calcula de los servicios.',
    example: '2026-09-10T09:00:00.000Z',
  })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Servicios de la cita, en orden. Su precio y su duración se **congelan** al reservar: ' +
      'cambiar la tarifa del catálogo después no altera esta cita.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  // Los datos demo históricos usan códigos estables con prefijo `svc-`; los servicios
  // nuevos usan UUIDv7. Ambos son identificadores internos válidos del catálogo.
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  serviceIds!: string[];

  @ApiPropertyOptional({ enum: SOURCES, default: 'WALK_IN' })
  @IsOptional()
  @IsEnum(SOURCES)
  source?: (typeof SOURCES)[number];

  @ApiPropertyOptional({ description: 'Notas visibles para la clienta', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional({
    description: 'Notas internas del equipo: fórmulas, avisos. No se muestran a la clienta.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'Reserva fuera del horario del profesional. Queda registrado en la auditoría. ' +
      'El solapamiento con otra cita **nunca** se puede forzar: lo impide la base de datos.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class RescheduleAppointmentDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Nueva hora de inicio. La duración se conserva.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional({ format: 'uuid', description: 'Nuevo profesional, sin mover la hora' })
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class CancelAppointmentDto {
  @ApiPropertyOptional({
    description: 'Motivo de la cancelación. Se guarda en la ficha y en la auditoría.',
    example: 'La clienta ha avisado de que está enferma',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateAppointmentNotesDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Editable incluso en citas terminadas: es donde se apunta la fórmula usada.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string | null;
}

export class AppointmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsEnum(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({
    description: 'Solo las que ocupan sillón: pendientes, confirmadas o en curso',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  onlyBlocking?: boolean;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class AvailabilityQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stylistId!: string;

  @ApiProperty({ example: '2026-09-10', description: 'Día en la zona horaria del salón' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato esperado YYYY-MM-DD' })
  date!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Servicios que se quieren reservar. Determinan cuánto tiene que durar el hueco.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  serviceIds!: string[];

  @ApiPropertyOptional({
    minimum: 5,
    maximum: 120,
    default: 15,
    description: 'Cada cuántos minutos se ofrece un inicio posible',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(120)
  granularityMinutes?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10_080,
    description: 'Antelación mínima para reservar, en minutos. Da margen a preparar el material.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_080)
  minimumNoticeMinutes?: number;
}

export class CalendarQueryDto {
  @ApiProperty({ format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @ApiProperty({ format: 'date-time', description: 'Máximo 31 días desde `from`' })
  @Type(() => Date)
  @IsDate()
  to!: Date;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Limita la vista a estos profesionales. Sin indicar, todos.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  // Sin version: el sistema genera UUIDv7 (ADR-0002), y exigir la 4 rechazaria
  // todos los identificadores que el propio sistema emite.
  @IsUUID(undefined, { each: true })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  stylistIds?: string[];
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export class AppointmentLineResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty({ description: 'Duración congelada al reservar, margen incluido' })
  durationMinutes!: number;
  @ApiProperty({ example: '25.00', description: 'Precio congelado al reservar' }) price!: string;
  @ApiProperty() sortOrder!: number;
}

export class AppointmentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) clientId!: string;
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ example: 55 }) durationMinutes!: number;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: SOURCES }) source!: string;

  @ApiProperty({ description: 'La cita ocupa sillón en el calendario' })
  isBlocking!: boolean;

  @ApiProperty({ description: 'Estado final: ya no admite más transiciones' })
  isFinished!: boolean;

  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) internalNotes!: string | null;

  @ApiProperty({ type: [AppointmentLineResponse] })
  services!: AppointmentLineResponse[];

  @ApiProperty({
    example: '40.00',
    description: 'Importe previsto, como cadena decimal. El real vive en la factura.',
  })
  estimatedTotal!: string;

  @ApiProperty({ example: 'GTQ' }) currency!: string;

  @ApiProperty({ nullable: true, format: 'date-time' }) confirmedAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true }) cancellationReason!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) noShowAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static from(appointment: Appointment): AppointmentResponse {
    return {
      id: appointment.id,
      clientId: appointment.clientId,
      stylistId: appointment.stylistId,
      startsAt: appointment.period.startsAt.toISOString(),
      endsAt: appointment.period.endsAt.toISOString(),
      durationMinutes: appointment.durationMinutes,
      status: appointment.status,
      source: appointment.source,
      isBlocking: appointment.isBlocking,
      isFinished: appointment.isFinished,
      notes: appointment.notes,
      internalNotes: appointment.internalNotes,
      services: appointment.lines.map((line) => ({
        id: line.id,
        serviceId: line.serviceId,
        durationMinutes: line.durationMinutes,
        price: line.price.toDecimalString(),
        sortOrder: line.sortOrder,
      })),
      estimatedTotal: appointment.estimatedTotal.toDecimalString(),
      currency: appointment.currency,
      confirmedAt: appointment.confirmedAt?.toISOString() ?? null,
      startedAt: appointment.startedAt?.toISOString() ?? null,
      completedAt: appointment.completedAt?.toISOString() ?? null,
      cancelledAt: appointment.cancelledAt?.toISOString() ?? null,
      cancellationReason: appointment.cancellationReason,
      noShowAt: appointment.noShowAt?.toISOString() ?? null,
      createdAt: appointment.audit.createdAt.toISOString(),
      updatedAt: appointment.audit.updatedAt.toISOString(),
    };
  }
}

export class AvailableSlotResponse {
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty() durationMinutes!: number;
}
