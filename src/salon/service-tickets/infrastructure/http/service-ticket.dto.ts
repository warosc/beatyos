import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, ServiceTicketStatus } from '@prisma/client';

import {
  PageMetaResponse,
  PaginationQueryDto,
} from '../../../../shared/infrastructure/http/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterServiceTicketDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Servicios realizados' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  serviceIds!: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Ficha de la clienta atendida' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({
    description: 'Nombre de una clienta de paso sin ficha. Se ignora si llega `clientId`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trim)
  clientName?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cita atendida. Aporta la clienta y queda completada al registrar.',
  })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo con `service-tickets.create`: profesional que realizó el servicio. Con ' +
      '`service-tickets.create.own` siempre es quien inicia sesión.',
  })
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @ApiPropertyOptional({ description: 'Observaciones para caja' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  notes?: string;
}

class TicketPaymentDto {
  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod) method!: PaymentMethod;

  @ApiProperty({ example: 112 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) reference?: string;
}

export class ChargeServiceTicketDto {
  @ApiProperty({
    type: [TicketPaymentDto],
    description: 'Deben sumar exactamente el total de la comanda, como en `POST /sales`.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TicketPaymentDto)
  payments!: TicketPaymentDto[];
}

export class CancelServiceTicketDto {
  @ApiProperty({ example: 'Registrado a la clienta equivocada' })
  @IsString()
  @MinLength(3)
  @MaxLength(250)
  @Transform(trim)
  reason!: string;
}

export class ServiceTicketQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ServiceTicketStatus })
  @IsOptional()
  @IsEnum(ServiceTicketStatus)
  status?: ServiceTicketStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo con `service-tickets.read`. Con `.own` se ignora.',
  })
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

export class AssignableServicesQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo con `service-tickets.create`. Con `.own` se usa la ficha propia.',
  })
  @IsOptional()
  @IsUUID()
  stylistId?: string;
}

// ---------------------------------------------------------------------------

export class ServiceTicketLineResponse {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Precio sin impuesto' }) unitPrice!: string;
  @ApiProperty({ nullable: true, type: Number }) taxRate!: number | null;
  @ApiProperty({ description: 'Precio con impuesto' }) lineTotal!: string;
  @ApiProperty() available!: boolean;
}

export class ServiceTicketResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ServiceTicketStatus }) status!: string;
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty() stylistName!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) clientId!: string | null;
  @ApiProperty() clientName!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) appointmentId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) invoiceId!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ type: [ServiceTicketLineResponse] }) lines!: ServiceTicketLineResponse[];
  @ApiProperty() total!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) chargedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
}

export class ServiceTicketPageResponse {
  @ApiProperty({ type: [ServiceTicketResponse] }) data!: ServiceTicketResponse[];
  @ApiProperty({ type: PageMetaResponse }) meta!: PageMetaResponse;
}

export class ServiceTicketChargeResponse {
  @ApiProperty({ format: 'uuid' }) ticketId!: string;
  @ApiProperty({ enum: ServiceTicketStatus }) status!: string;
  @ApiProperty({ format: 'uuid' }) invoiceId!: string;
  @ApiProperty({ example: 'F2026-000123' }) number!: string;
  @ApiProperty() total!: string;
}

export class ServiceTicketCancelResponse {
  @ApiProperty({ format: 'uuid' }) ticketId!: string;
  @ApiProperty({ enum: ServiceTicketStatus }) status!: string;
}

export class AssignableServiceResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty({ description: 'Precio que paga la clienta, IVA incluido' }) price!: string;
  @ApiProperty() priceWithTax!: string;
  @ApiProperty() currency!: string;
}
