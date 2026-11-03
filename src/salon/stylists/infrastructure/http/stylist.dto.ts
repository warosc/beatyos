import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEmail,
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
import { formatMinutes } from '../../../../shared/domain/time/zoned-time';
import type { StylistRetirementCheck } from '../../application/stylist.use-cases';
import type { Stylist } from '../../domain/stylist.entity';

const STATUSES = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'] as const;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateStylistDto {
  @ApiProperty({ example: 'Sara' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  firstName!: string;

  @ApiProperty({ example: 'Molina' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  lastName!: string;

  @ApiPropertyOptional({ example: 'sara@salon.es' })
  @IsOptional()
  @IsEmail()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || null : value,
  )
  email?: string | null;

  @ApiPropertyOptional({ example: '+34600111222' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({
    description: 'Nombre con el que aparece en la agenda. Por defecto, el de pila.',
    example: 'Sara',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  displayName?: string | null;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string | null;

  @ApiPropertyOptional({
    example: '#EC4899',
    description: 'Color con el que se pinta en el calendario',
  })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ format: 'date', example: '2024-03-01' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hiredAt?: Date | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description:
      '% en servicios: lo que gana de lo que paga la clienta por cada servicio. Un servicio o una habilidad pueden sobreescribirlo.',
    example: 15,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    default: 10,
    description:
      '% en productos: lo que gana de cada producto cobrado a su nombre. La comisión especial del producto manda sobre esta (ADR-0026).',
    example: 10,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  productCommissionRate?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cuenta de acceso asociada. Opcional: no todo profesional usa el sistema.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string | null;
}

export class UpdateStylistDto extends CreateStylistDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsEnum(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  declare firstName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  declare lastName: string;
}

export class WorkingBlockDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo … 6 = sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({
    example: '09:00',
    description:
      'Hora local del salón. La conversión a instante la hace el servidor con la zona del salón.',
  })
  @IsString()
  @Matches(/^([01]?\d|2[0-4]):[0-5]\d$/, { message: 'Formato esperado HH:MM' })
  start!: string;

  @ApiProperty({
    example: '20:00',
    description: 'Use `24:00` para un turno que acaba a medianoche.',
  })
  @IsString()
  @Matches(/^([01]?\d|2[0-4]):[0-5]\d$/, { message: 'Formato esperado HH:MM' })
  end!: string;
}

export class SetScheduleDto {
  @ApiProperty({
    type: [WorkingBlockDto],
    description:
      'Horario semanal completo. **Reemplaza** el anterior: enviar una lista vacía deja al ' +
      'profesional sin disponibilidad.',
  })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => WorkingBlockDto)
  blocks!: WorkingBlockDto[];
}

export class AddTimeOffDto {
  @ApiProperty({ format: 'date-time', description: 'Inicio de la ausencia, en ISO 8601' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty({ format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  endsAt!: Date;

  @ApiPropertyOptional({ example: 'Vacaciones' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string | null;
}

export class SkillDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({
    description:
      'Duración propia de este profesional para el servicio. Sin indicar, se usa la del catálogo.',
    minimum: 5,
    maximum: 480,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionRate?: number | null;
}

export class SetSkillsDto {
  @ApiProperty({
    type: [SkillDto],
    description:
      'Servicios que sabe hacer. **Reemplaza** la lista anterior. Una lista vacía significa ' +
      '«puede hacerlo todo», que es el comportamiento por defecto de un salón recién dado de alta.',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SkillDto)
  skills!: SkillDto[];
}

export class StylistQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Busca en nombre, apellidos, correo y nombre visible' })
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
    format: 'uuid',
    description:
      'Solo quienes saben hacer este servicio. Incluye también a quien no tiene habilidades ' +
      'declaradas, porque entonces se asume que puede hacerlo todo.',
  })
  @IsOptional()
  @IsUUID()
  canPerformServiceId?: string;

  @ApiPropertyOptional({ description: 'Solo profesionales que admiten reservas' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  onlyBookable?: boolean;
}

export class WorkingHoursQueryDto {
  @ApiProperty({ example: '2026-09-07', description: 'Primer día, en la zona del salón' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato esperado YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-09-13', description: 'Último día, inclusive. Máximo 62 días.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato esperado YYYY-MM-DD' })
  to!: string;
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export class StylistResponse {
  @ApiProperty() id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) bio!: string | null;
  @ApiProperty({ example: '#EC4899' }) color!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ description: 'Admite reservas nuevas' }) isBookable!: boolean;
  @ApiProperty({ nullable: true, format: 'date' }) hiredAt!: string | null;
  @ApiProperty({ example: 15, description: '% en servicios' }) commissionRate!: number;
  @ApiProperty({ example: 10, description: '% en productos' }) productCommissionRate!: number;
  @ApiProperty({ nullable: true, format: 'uuid' }) userId!: string | null;

  @ApiProperty({
    description: 'Horario semanal, con las horas en formato local del salón',
    example: [{ id: 'b1', dayOfWeek: 4, start: '09:00', end: '20:00' }],
  })
  schedule!: { id: string; dayOfWeek: number; start: string; end: string }[];

  @ApiProperty({ description: 'Minutos de trabajo a la semana', example: 2400 })
  weeklyMinutes!: number;

  @ApiProperty({
    description: 'Ausencias registradas',
    example: [
      {
        id: 't1',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-08-15T00:00:00.000Z',
        reason: 'Vacaciones',
      },
    ],
  })
  timeOff!: { id: string; startsAt: string; endsAt: string; reason: string | null }[];

  @ApiProperty({
    description: 'Servicios que sabe hacer. Vacío significa que puede hacerlos todos.',
  })
  skills!: { serviceId: string; durationMinutes: number | null; commissionRate: number | null }[];

  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) deletedAt?: string | null;

  static from(stylist: Stylist): StylistResponse {
    return {
      id: stylist.id,
      firstName: stylist.name.firstName,
      lastName: stylist.name.lastName,
      fullName: stylist.name.full,
      displayName: stylist.displayName,
      email: stylist.email?.value ?? null,
      phone: stylist.phone?.value ?? null,
      bio: stylist.bio,
      color: stylist.color,
      status: stylist.status,
      isBookable: stylist.isBookable(),
      hiredAt: stylist.hiredAt?.toISOString().slice(0, 10) ?? null,
      commissionRate: stylist.commissionRate.value,
      productCommissionRate: stylist.productCommissionRate.value,
      userId: stylist.userId,
      schedule: stylist.schedule.map((block) => ({
        id: block.id,
        dayOfWeek: block.dayOfWeek,
        // Se devuelve la hora local, que es como se introdujo y como la entiende quien
        // gestiona el salón. El instante absoluto solo aparece en la agenda.
        start: formatMinutes(block.startMinutes),
        end: formatMinutes(block.endMinutes),
      })),
      weeklyMinutes: stylist.weeklyMinutes,
      timeOff: stylist.timeOff.map((period) => ({
        id: period.id,
        startsAt: period.range.startsAt.toISOString(),
        endsAt: period.range.endsAt.toISOString(),
        reason: period.reason,
      })),
      skills: stylist.skills.map((skill) => ({
        serviceId: skill.serviceId,
        durationMinutes: skill.durationMinutes,
        commissionRate: skill.commissionRate?.value ?? null,
      })),
      createdAt: stylist.audit.createdAt.toISOString(),
      updatedAt: stylist.audit.updatedAt.toISOString(),
      ...(stylist.audit.deletedAt ? { deletedAt: stylist.audit.deletedAt.toISOString() } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Baja (ADR-0027)
// ---------------------------------------------------------------------------

export class RetirementAppointmentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ example: 'CONFIRMED' }) status!: string;
  @ApiProperty({ example: 'Rosa Iglesias' }) clientName!: string;
  @ApiProperty({ type: [String], example: ['Corte de señora'] }) serviceNames!: string[];
}

export class RetirementTicketResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ example: 'Rosa Iglesias' }) clientName!: string;
}

export class RetirementQueueTurnResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 12 }) number!: number;
  @ApiProperty({ example: 'Rosa' }) clientName!: string;
  @ApiProperty({ example: 'IN_SERVICE' }) status!: string;
}

export class StylistRetirementResponse {
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty({ example: 'Sara' }) displayName!: string;
  @ApiProperty({
    description: 'Si hay algo pendiente que impide darla de baja ahora.',
  })
  blocked!: boolean;
  @ApiProperty({ description: 'Citas por atender o en curso, sin contar las listadas' })
  appointmentsTotal!: number;
  @ApiProperty({ type: [RetirementAppointmentResponse], description: 'Las primeras 50' })
  appointments!: RetirementAppointmentResponse[];
  @ApiProperty() pendingTicketsTotal!: number;
  @ApiProperty({ type: [RetirementTicketResponse], description: 'Las primeras 50' })
  pendingTickets!: RetirementTicketResponse[];
  @ApiProperty({ type: [RetirementQueueTurnResponse] })
  activeQueueTurns!: RetirementQueueTurnResponse[];
  @ApiProperty({
    description: 'Clientas en espera que la pidieron. No bloquean: pasan a la fila general.',
  })
  waitingPreferences!: number;
  @ApiProperty({ description: 'Tiene cuenta de acceso al sistema' }) hasAccount!: boolean;
  @ApiProperty({ description: 'Su acceso se desactivará con la baja' })
  accountWillBeDeactivated!: boolean;

  static from(check: StylistRetirementCheck): StylistRetirementResponse {
    const work = check.pendingWork;
    return {
      stylistId: check.stylist.id,
      displayName: check.stylist.displayName,
      blocked: check.blocked,
      appointmentsTotal: work.appointments.total,
      appointments: work.appointments.items.map((item) => ({
        id: item.id,
        startsAt: item.startsAt.toISOString(),
        endsAt: item.endsAt.toISOString(),
        status: item.status,
        clientName: item.clientName,
        serviceNames: [...item.serviceNames],
      })),
      pendingTicketsTotal: work.pendingTickets.total,
      pendingTickets: work.pendingTickets.items.map((item) => ({
        id: item.id,
        createdAt: item.createdAt.toISOString(),
        clientName: item.clientName,
      })),
      activeQueueTurns: work.activeQueueTurns.map((turn) => ({ ...turn })),
      waitingPreferences: work.waitingPreferences,
      hasAccount: check.account.linked,
      accountWillBeDeactivated: check.account.willBeDeactivated,
    };
  }
}

export class WorkingHoursResponse {
  @ApiProperty({ example: '2026-09-10' }) date!: string;

  @ApiProperty({
    description:
      'Tramos trabajables, **ya descontadas las ausencias**. No descuenta las citas: eso es ' +
      'capacidad, no disponibilidad. Los huecos libres los da el módulo de agenda.',
    example: [{ startsAt: '2026-09-10T07:00:00.000Z', endsAt: '2026-09-10T12:00:00.000Z' }],
  })
  intervals!: readonly { startsAt: string; endsAt: string }[];

  @ApiProperty({ example: 300 }) totalMinutes!: number;
}
