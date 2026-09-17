import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CashMovementType } from '@prisma/client';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { ForbiddenActionError } from '../../../../shared/domain/errors';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { CurrentUser, RequirePermissions } from '../../../../shared/infrastructure/http/decorators';
import {
  CloseCashSessionUseCase,
  GetCurrentCashSessionUseCase,
  OpenCashSessionUseCase,
  RecordCashMovementUseCase,
  SearchCashSessionsUseCase,
} from '../../application/cash.use-cases';
import {
  CashSessionEnvelopeResponse,
  CashSessionPageResponse,
  RecordCashMovementEnvelopeResponse,
  toCashMovementResponse,
  toCashSessionResponse,
} from './cash.response';

/**
 * Adaptador HTTP de caja.
 *
 * Las rutas y la forma de la respuesta son las mismas que antes de la reconciliación:
 * `apps/web` lee `openingFloat`, `cashSales`, `expectedAmount` y `movements` **planos sobre
 * la sesión**, así que el presentador los aplana aunque por dentro sean un agregado y una
 * cifra calculada aparte.
 */

export class OpenCashDto {
  @ApiProperty({ example: 500, description: 'Fondo con el que se abre el cajón' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingFloat!: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CashMovementDto {
  @ApiProperty({ enum: CashMovementType }) @IsEnum(CashMovementType) type!: CashMovementType;

  @ApiProperty({ example: 25.5, description: 'Siempre positivo; el sentido lo da el tipo' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  amount!: number;

  @ApiProperty({ example: 'Compra de cambio en el banco' })
  @IsString()
  @MaxLength(160)
  concept!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CloseCashDto {
  @ApiProperty({ example: 812.4, description: 'Efectivo contado físicamente' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  countedAmount!: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CashHistoryQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ---------------------------------------------------------------------------

@ApiTags('Caja')
@Controller({ path: 'cash', version: '1' })
export class CashController {
  private readonly currency: string;

  constructor(
    private readonly currentSession: GetCurrentCashSessionUseCase,
    private readonly openSession: OpenCashSessionUseCase,
    private readonly recordMovement: RecordCashMovementUseCase,
    private readonly closeSession: CloseCashSessionUseCase,
    private readonly searchSessions: SearchCashSessionsUseCase,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  @Get('current')
  @RequirePermissions(PERMISSIONS.cash.read)
  @ApiOperation({
    operationId: 'cash_current',
    summary: 'Caja abierta con lo esperado en el cajón. `null` si está cerrada',
  })
  @ApiOkResponse({ type: CashSessionEnvelopeResponse })
  async current() {
    const view = await this.currentSession.execute();
    return view ? toCashSessionResponse(view) : null;
  }

  @Get('history')
  @RequirePermissions(PERMISSIONS.cash.read)
  @ApiOperation({ operationId: 'cash_history', summary: 'Historial de cajas cerradas' })
  @ApiOkResponse({ type: CashSessionPageResponse })
  async history(@Query() query: CashHistoryQueryDto) {
    const page = await this.searchSessions.execute({
      filter: {},
      page: { page: query.page ?? 1, limit: query.limit ?? 50 },
    });

    return { data: page.data.map(toCashSessionResponse), meta: page.meta };
  }

  @Post('open')
  @RequirePermissions(PERMISSIONS.cash.open)
  @ApiOperation({ operationId: 'cash_open', summary: 'Abre la caja del día' })
  @ApiCreatedResponse({ type: CashSessionEnvelopeResponse })
  async open(@Body() dto: OpenCashDto, @CurrentUser() user: AccessTokenClaims) {
    const view = await this.openSession.execute({
      tenantId: requireTenant(user),
      openingFloat: dto.openingFloat.toFixed(2),
      currency: this.currency,
      notes: dto.notes ?? null,
      actorId: user.sub,
    });

    return toCashSessionResponse(view);
  }

  @Post('movements')
  @RequirePermissions(PERMISSIONS.cash.movement)
  @ApiOperation({
    operationId: 'cash_movement',
    summary: 'Anota una entrada o salida manual de efectivo',
  })
  @ApiCreatedResponse({ type: RecordCashMovementEnvelopeResponse })
  async movement(@Body() dto: CashMovementDto, @CurrentUser() user: AccessTokenClaims) {
    const { movement, view } = await this.recordMovement.execute({
      type: dto.type,
      amount: dto.amount.toFixed(2),
      concept: dto.concept,
      reference: dto.reference ?? null,
      notes: dto.notes ?? null,
      actorId: user.sub,
    });

    // Se devuelve el movimiento **y** la caja: quien anota una salida quiere ver de
    // inmediato cuánto queda, y pedirlo en una segunda petición deja una ventana en la que
    // la pantalla muestra una cifra que ya no es cierta.
    return { ...toCashMovementResponse(movement), session: toCashSessionResponse(view) };
  }

  @Post('close')
  @RequirePermissions(PERMISSIONS.cash.close)
  @ApiOperation({
    operationId: 'cash_close',
    summary: 'Arquea y cierra. No rechaza el descuadre: lo registra',
  })
  @ApiCreatedResponse({ type: CashSessionEnvelopeResponse })
  async close(@Body() dto: CloseCashDto, @CurrentUser() user: AccessTokenClaims) {
    const view = await this.closeSession.execute({
      countedAmount: dto.countedAmount.toFixed(2),
      notes: dto.notes ?? null,
      actorId: user.sub,
    });

    return toCashSessionResponse(view);
  }
}

// ---------------------------------------------------------------------------

const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError('cash.open', 'Abrir caja requiere estar asignado a un salón');
  }
  return user.tenantId;
};
