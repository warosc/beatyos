import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { QueueTurnStatus } from '@prisma/client';

import { ServiceTicketResponse } from '../../../service-tickets/infrastructure/http/service-ticket.dto';
import type { QueueDisplay, QueueTurnView } from '../../application/queue-board.use-cases';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterWalkInDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Ficha de la clienta, si la tiene' })
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
    type: [String],
    format: 'uuid',
    description: 'Lo que pide. Decide quién puede atenderla; lo que se cobra va en la comanda.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  serviceIds?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Profesional que pide la clienta' })
  @IsOptional()
  @IsUUID()
  preferredStylistId?: string;

  @ApiPropertyOptional({ description: 'Nota para quien la atienda' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Transform(trim)
  notes?: string;
}

export class CallNextDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo con `queue.attend`: profesional que queda libre. Con `queue.attend.own` siempre ' +
      'es quien inicia sesión.',
  })
  @IsOptional()
  @IsUUID()
  stylistId?: string;
}

export class CallTurnDto {
  @ApiProperty({ format: 'uuid', description: 'Profesional que la atenderá' })
  @IsUUID()
  stylistId!: string;
}

export class CancelTurnDto {
  @ApiPropertyOptional({ example: 'Se fue: no podía esperar' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  @Transform(trim)
  reason?: string;
}

export class FinishTurnDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Servicios realizados' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  serviceIds!: string[];

  @ApiPropertyOptional({ description: 'Observaciones para caja' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  notes?: string;
}

// ---------------------------------------------------------------------------

export class QueueTurnResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 7, description: 'Número del día' }) number!: number;
  @ApiProperty({ example: '2026-10-12' }) businessDate!: string;
  @ApiProperty({ enum: QueueTurnStatus }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) clientId!: string | null;
  @ApiProperty() clientName!: string;
  @ApiProperty({ type: [String] }) serviceIds!: string[];
  @ApiProperty({ type: [String] }) serviceNames!: string[];
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  preferredStylistId!: string | null;
  @ApiProperty({ nullable: true, type: String }) preferredStylistName!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) stylistId!: string | null;
  @ApiProperty({ nullable: true, type: String }) stylistName!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Puesto en la fila; 1 = la siguiente' })
  position!: number | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty() callCount!: number;
  @ApiProperty({ description: 'Llegada a la fila' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) calledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) closedAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) serviceTicketId!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;

  static from(view: QueueTurnView): QueueTurnResponse {
    const { turn } = view;
    return {
      id: turn.id,
      number: turn.number,
      businessDate: turn.businessDate,
      status: turn.status,
      clientId: turn.clientId,
      clientName: turn.clientName,
      serviceIds: [...turn.serviceIds],
      serviceNames: [...view.serviceNames],
      preferredStylistId: turn.preferredStylistId,
      preferredStylistName: view.preferredStylistName,
      stylistId: turn.stylistId,
      stylistName: view.stylistName,
      position: view.position,
      notes: turn.notes,
      callCount: turn.callCount,
      createdAt: turn.createdAt.toISOString(),
      calledAt: turn.calledAt?.toISOString() ?? null,
      startedAt: turn.startedAt?.toISOString() ?? null,
      closedAt: turn.closedAt?.toISOString() ?? null,
      serviceTicketId: turn.serviceTicketId,
      cancellationReason: turn.cancellationReason,
    };
  }
}

export class QueueBoardResponse {
  @ApiProperty({ example: '2026-10-12', description: 'Día del salón que se muestra' })
  businessDate!: string;
  @ApiProperty({ type: [QueueTurnResponse] }) turns!: QueueTurnResponse[];
}

export class CallNextResponse {
  @ApiProperty({
    type: QueueTurnResponse,
    nullable: true,
    description: '`null` si no queda nadie en la fila que esta profesional pueda atender',
  })
  turn!: QueueTurnResponse | null;
}

export class FinishTurnResponse {
  @ApiProperty({ type: QueueTurnResponse }) turn!: QueueTurnResponse;
  @ApiProperty({ type: ServiceTicketResponse }) ticket!: ServiceTicketResponse;
}

export class QueueDisplayLinkStatusResponse {
  @ApiProperty({ description: 'Si hay una pantalla con enlace vigente' }) active!: boolean;
}

export class QueueDisplayLinkResponse {
  @ApiProperty({
    description:
      'Enlace de la pantalla. Solo se enseña ahora: se guarda su hash. Emitir otro retira este.',
  })
  token!: string;
}

export class QueueDisplayCallResponse {
  @ApiProperty() id!: string;
  @ApiProperty() number!: number;
  @ApiProperty({ example: 'Ana G.' }) publicName!: string;
  @ApiProperty() stylistName!: string;
  @ApiProperty({ description: 'Sube con cada llamada: la pantalla anuncia de nuevo' })
  callCount!: number;
  @ApiProperty() calledAt!: string;
}

export class QueueDisplayResponse {
  @ApiProperty() salonName!: string;
  @ApiProperty({ type: [QueueDisplayCallResponse] }) called!: QueueDisplayCallResponse[];
  @ApiProperty({ type: [Number], description: 'Siguientes números en espera' }) waiting!: number[];
  @ApiProperty() waitingCount!: number;

  static from(display: QueueDisplay): QueueDisplayResponse {
    return {
      salonName: display.salonName,
      called: display.called.map((call) => ({
        id: call.id,
        number: call.number,
        publicName: call.publicName,
        stylistName: call.stylistName,
        callCount: call.callCount,
        calledAt: call.calledAt.toISOString(),
      })),
      waiting: [...display.waiting],
      waitingCount: display.waitingCount,
    };
  }
}
