import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { QueueTurnStatus } from '@prisma/client';

import { ServiceTicketResponse } from '../../../service-tickets/infrastructure/http/service-ticket.dto';
import type { QueueDisplay, QueueTurnView } from '../../application/queue-board.use-cases';
import type { QueueStatsView } from '../../application/queue-stats.use-cases';
import type { MinutesSummary } from '../../domain/queue-stats';

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
  @ApiProperty({ nullable: true, type: String, description: 'Primera llamada: fin de la espera' })
  firstCalledAt!: string | null;
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
      firstCalledAt: turn.firstCalledAt?.toISOString() ?? null,
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
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Espera media de hoy hasta la primera llamada, en minutos',
  })
  averageWaitMinutes!: number | null;
  @ApiProperty({ description: 'Llamadas de hoy con las que se calculó la media' })
  waitSamples!: number;
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
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Espera aproximada (media de hoy), solo con llamadas suficientes',
  })
  estimatedWaitMinutes!: number | null;

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
      estimatedWaitMinutes: display.estimatedWaitMinutes,
    };
  }
}

// ---------------------------------------------------------------------------
// Indicadores (ADR-0025)
// ---------------------------------------------------------------------------

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class QueueStatsQueryDto {
  @ApiPropertyOptional({ example: '2026-09-13', description: 'Primer día del salón, incluido' })
  @IsOptional()
  @Matches(CALENDAR_DAY, { message: 'from debe tener el formato AAAA-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-12', description: 'Último día del salón, incluido' })
  @IsOptional()
  @Matches(CALENDAR_DAY, { message: 'to debe tener el formato AAAA-MM-DD' })
  to?: string;
}

export class MinutesSummaryResponse {
  @ApiProperty({ nullable: true, type: Number }) average!: number | null;
  @ApiProperty({ nullable: true, type: Number }) median!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: '9 de cada 10, esto o menos' })
  p90!: number | null;
  @ApiProperty({ nullable: true, type: Number }) max!: number | null;
  @ApiProperty() samples!: number;
}

export class QueueHourStatResponse {
  @ApiProperty({ description: 'Hora local de llegada, 0–23' }) hour!: number;
  @ApiProperty() arrivals!: number;
  @ApiProperty() abandoned!: number;
  @ApiProperty({ nullable: true, type: Number }) averageWait!: number | null;
}

export class QueueWeekdayStatResponse {
  @ApiProperty({ description: '0 = domingo' }) weekday!: number;
  @ApiProperty() arrivals!: number;
  @ApiProperty({ description: 'Llegadas por cada día de ese tipo del periodo' })
  arrivalsPerDay!: number;
  @ApiProperty({ nullable: true, type: Number }) averageWait!: number | null;
}

export class QueueDayStatResponse {
  @ApiProperty({ example: '2026-10-12' }) date!: string;
  @ApiProperty() arrivals!: number;
  @ApiProperty() attended!: number;
  @ApiProperty() abandoned!: number;
  @ApiProperty({ nullable: true, type: Number }) averageWait!: number | null;
}

export class QueueStylistStatResponse {
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() attended!: number;
  @ApiProperty({ description: 'Cuántas la pidieron por su nombre' }) requested!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Minutos de sillón, de media' })
  averageService!: number | null;
}

export class QueueServiceDemandResponse {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() requests!: number;
}

export class QueueInsightResponse {
  @ApiProperty({
    enum: ['peak-hour', 'slowest-hour', 'leave-after', 'busiest-weekday', 'most-requested'],
  })
  kind!: string;
  @ApiPropertyOptional() hour?: number;
  @ApiPropertyOptional() arrivals?: number;
  @ApiPropertyOptional() averageWait?: number;
  @ApiPropertyOptional() minutes?: number;
  @ApiPropertyOptional() samples?: number;
  @ApiPropertyOptional() weekday?: number;
  @ApiPropertyOptional() arrivalsPerDay?: number;
  @ApiPropertyOptional() stylistId?: string;
  @ApiPropertyOptional() stylistName?: string;
  @ApiPropertyOptional() requested?: number;
}

export class QueueStatsResponse {
  @ApiProperty({ example: '2026-09-13' }) from!: string;
  @ApiProperty({ example: '2026-10-12' }) to!: string;
  @ApiProperty({ description: 'Clientas que llegaron sin cita' }) arrivals!: number;
  @ApiProperty() attended!: number;
  @ApiProperty({ description: 'Se fueron o las sacaron de la fila' }) left!: number;
  @ApiProperty({ description: 'Las llamaron y no aparecieron' }) noShow!: number;
  @ApiProperty({ description: 'Seguían en la fila al terminar su día' }) unattended!: number;
  @ApiProperty({ description: 'Hoy, todavía en la fila o en atención' }) pending!: number;
  @ApiProperty() abandoned!: number;
  @ApiProperty({ nullable: true, type: Number, description: '% de perdidas sobre las resueltas' })
  abandonmentRate!: number | null;
  @ApiProperty({ type: MinutesSummaryResponse, description: 'De la llegada a la primera llamada' })
  wait!: MinutesSummaryResponse;
  @ApiProperty({
    type: MinutesSummaryResponse,
    description: 'Cuánto aguantaron las que se fueron sin que las llamaran',
  })
  waitBeforeLeaving!: MinutesSummaryResponse;
  @ApiProperty({ type: MinutesSummaryResponse, description: 'Del sillón al final' })
  service!: MinutesSummaryResponse;
  @ApiProperty({ description: 'Cobrado por las comandas de la fila, IVA incluido' })
  revenue!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() chargedTurns!: number;
  @ApiProperty({ type: [QueueHourStatResponse] }) byHour!: QueueHourStatResponse[];
  @ApiProperty({ type: [QueueWeekdayStatResponse] }) byWeekday!: QueueWeekdayStatResponse[];
  @ApiProperty({ type: [QueueDayStatResponse] }) byDay!: QueueDayStatResponse[];
  @ApiProperty({ type: [QueueStylistStatResponse] }) byStylist!: QueueStylistStatResponse[];
  @ApiProperty({ type: [QueueServiceDemandResponse] })
  byService!: QueueServiceDemandResponse[];
  @ApiProperty({ type: [QueueInsightResponse] }) insights!: QueueInsightResponse[];

  static from({ stats, stylistNames, serviceNames }: QueueStatsView): QueueStatsResponse {
    const stylistName = (id: string) => stylistNames.get(id) ?? 'Profesional';
    const minutes = (summary: MinutesSummary): MinutesSummaryResponse => ({ ...summary });
    return {
      from: stats.period.from,
      to: stats.period.to,
      arrivals: stats.arrivals,
      attended: stats.attended,
      left: stats.left,
      noShow: stats.noShow,
      unattended: stats.unattended,
      pending: stats.pending,
      abandoned: stats.abandoned,
      abandonmentRate: stats.abandonmentRate,
      wait: minutes(stats.wait),
      waitBeforeLeaving: minutes(stats.waitBeforeLeaving),
      service: minutes(stats.service),
      revenue: stats.revenue.toDecimalString(),
      currency: stats.revenue.currency,
      chargedTurns: stats.chargedTurns,
      byHour: stats.byHour.map((hour) => ({ ...hour })),
      byWeekday: stats.byWeekday.map((day) => ({ ...day })),
      byDay: stats.byDay.map((day) => ({ ...day })),
      byStylist: stats.byStylist.map((stylist) => ({
        ...stylist,
        name: stylistName(stylist.stylistId),
      })),
      byService: stats.byService.map((service) => ({
        ...service,
        name: serviceNames.get(service.serviceId) ?? 'Servicio retirado',
      })),
      insights: stats.insights.map((insight) =>
        insight.kind === 'most-requested'
          ? { ...insight, stylistName: stylistName(insight.stylistId) }
          : { ...insight },
      ),
    };
  }
}
