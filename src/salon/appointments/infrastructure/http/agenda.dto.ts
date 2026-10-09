import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

import type { StylistShifts } from '../../application/appointment.use-cases';
import type { ManualReminder, PublicAppointmentView } from '../../application/reminder.use-cases';
import type { AppointmentSummary } from '../../domain/agenda.ports';
import type { AppointmentChangeRequest } from '../../domain/change-request.entity';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHANGE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

// ---------------------------------------------------------------------------
// Turnos y bloqueos
// ---------------------------------------------------------------------------

export class ShiftsQueryDto {
  @ApiProperty({ example: '2026-10-08', description: 'Primer día, en la zona del salón' })
  @Matches(DAY, { message: 'Formato esperado YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-10-14', description: 'Último día, incluido. Máximo 42 días.' })
  @Matches(DAY, { message: 'Formato esperado YYYY-MM-DD' })
  to!: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  stylistIds?: string[];
}

class IntervalResponse {
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
}

class ShiftDayResponse {
  @ApiProperty({ example: '2026-10-08' }) date!: string;
  @ApiProperty({ type: [IntervalResponse] }) intervals!: IntervalResponse[];
}

class BlockResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
}

export class StylistShiftsResponse {
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: '#EC4899' }) color!: string;
  @ApiProperty() isBookable!: boolean;
  @ApiProperty({ type: [String], description: 'Servicios que hace. Vacío: todos.' })
  serviceIds!: string[];
  @ApiProperty({ type: [ShiftDayResponse] }) days!: ShiftDayResponse[];
  @ApiProperty({ type: [BlockResponse] }) blocks!: BlockResponse[];

  static from(shifts: StylistShifts): StylistShiftsResponse {
    return {
      stylistId: shifts.stylistId,
      name: shifts.name,
      color: shifts.color,
      isBookable: shifts.isBookable,
      serviceIds: [...shifts.serviceIds],
      days: shifts.days.map((day) => ({
        date: day.date,
        intervals: day.intervals.map((interval) => ({
          startsAt: interval.startsAt.toISOString(),
          endsAt: interval.endsAt.toISOString(),
        })),
      })),
      blocks: shifts.blocks.map((block) => ({
        id: block.id,
        startsAt: block.startsAt.toISOString(),
        endsAt: block.endsAt.toISOString(),
        reason: block.reason,
      })),
    };
  }
}

export class BlockTimeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stylistId!: string;

  @ApiProperty({ format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty({ format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  endsAt!: Date;

  @ApiPropertyOptional({ example: 'Comida', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// ---------------------------------------------------------------------------
// Solicitudes de cambio
// ---------------------------------------------------------------------------

export class RequestChangeDto {
  @ApiProperty({ format: 'date-time', description: 'Hora a la que se propone mover la cita' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiPropertyOptional({ example: 'La clienta pidió venir más tarde', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DecideChangeDto {
  @ApiPropertyOptional({ example: 'Ese hueco ya lo tiene otra clienta', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ChangeRequestQueryDto {
  @ApiPropertyOptional({ enum: CHANGE_STATUSES })
  @IsOptional()
  @IsEnum(CHANGE_STATUSES)
  status?: (typeof CHANGE_STATUSES)[number];

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Solo las decididas desde este instante',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  decidedSince?: Date;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ChangeRequestResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) appointmentId!: string;
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty({ nullable: true, type: String }) stylistName!: string | null;
  @ApiProperty({ nullable: true, type: String }) stylistColor!: string | null;
  @ApiProperty({ nullable: true, type: String }) clientName!: string | null;
  @ApiProperty({ type: [String] }) serviceNames!: string[];
  @ApiProperty({ description: 'Duración de la cita, en minutos' }) durationMinutes!: number;
  @ApiProperty({ nullable: true, type: String, description: 'Estado actual de la cita' })
  appointmentStatus!: string | null;
  @ApiProperty({ format: 'date-time', description: 'Hora de la cita al pedir el cambio' })
  currentStartsAt!: string;
  @ApiProperty({ format: 'date-time' }) proposedStartsAt!: string;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ enum: CHANGE_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote!: string | null;

  static from(
    request: AppointmentChangeRequest,
    summary: AppointmentSummary | undefined,
  ): ChangeRequestResponse {
    const durationMs = summary ? summary.endsAt.getTime() - summary.startsAt.getTime() : 0;
    return {
      id: request.id,
      appointmentId: request.appointmentId,
      stylistId: request.stylistId,
      stylistName: summary?.stylistName ?? null,
      stylistColor: summary?.stylistColor ?? null,
      clientName: summary?.clientName ?? null,
      serviceNames: [...(summary?.serviceNames ?? [])],
      durationMinutes: Math.round(durationMs / 60_000),
      appointmentStatus: summary?.status ?? null,
      currentStartsAt: request.currentStartsAt.toISOString(),
      proposedStartsAt: request.proposedStartsAt.toISOString(),
      reason: request.reason,
      status: request.status,
      requestedAt: request.createdAt.toISOString(),
      decidedAt: request.decidedAt?.toISOString() ?? null,
      decisionNote: request.decisionNote,
    };
  }
}

// ---------------------------------------------------------------------------
// Recordatorios
// ---------------------------------------------------------------------------

export class ManualReminderResponse {
  @ApiProperty({ description: 'Mensaje ya redactado, con el enlace de confirmación' })
  message!: string;
  @ApiProperty({ nullable: true, type: String, example: '+50255551234' })
  phone!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Enlace wa.me que abre la conversación con el mensaje escrito',
  })
  whatsappUrl!: string | null;

  static from(reminder: ManualReminder): ManualReminderResponse {
    return { ...reminder };
  }
}

export class ReminderRunResponse {
  @ApiProperty() sent!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() skipped!: number;
}

export class ReminderSettingsResponse {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['LOG', 'WHATSAPP', 'SMS'] }) channel!: string;
  @ApiProperty() leadHours!: number;
}

// ---------------------------------------------------------------------------
// Enlace público de la clienta
// ---------------------------------------------------------------------------

export class PublicCancelDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class PublicAppointmentResponse {
  @ApiProperty() salonName!: string;
  @ApiProperty() clientFirstName!: string;
  @ApiProperty() stylistName!: string;
  @ApiProperty({ type: [String] }) serviceNames!: string[];
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty() status!: string;
  @ApiProperty() canConfirm!: boolean;
  @ApiProperty() canCancel!: boolean;

  static from(view: PublicAppointmentView): PublicAppointmentResponse {
    return { ...view, serviceNames: [...view.serviceNames] };
  }
}
