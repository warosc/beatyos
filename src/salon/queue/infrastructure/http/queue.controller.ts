import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { WILDCARD_PERMISSION } from '../../../../shared/domain/authorization';
import { DomainValidationError, ForbiddenActionError } from '../../../../shared/domain/errors';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import { ListServiceTicketsUseCase } from '../../../service-tickets/application/service-ticket.use-cases';
import { ServiceTicketResponse } from '../../../service-tickets/infrastructure/http/service-ticket.dto';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../../stylists/domain/stylist.repository';
import {
  GetQueueBoardUseCase,
  IssueQueueDisplayLinkUseCase,
} from '../../application/queue-board.use-cases';
import { GetQueueStatsUseCase } from '../../application/queue-stats.use-cases';
import {
  CallNextUseCase,
  CallTurnUseCase,
  ChangeQueueTurnUseCase,
  FinishQueueTurnUseCase,
  RegisterWalkInUseCase,
  type QueueTurnAction,
} from '../../application/queue.use-cases';
import type { QueueTurn } from '../../domain/queue-turn.entity';
import { QUEUE_DISPLAY_LINKS, type QueueDisplayLinks } from '../../domain/queue.ports';
import {
  CallNextDto,
  CallNextResponse,
  CallTurnDto,
  CancelTurnDto,
  FinishTurnDto,
  FinishTurnResponse,
  QueueBoardResponse,
  QueueDisplayLinkResponse,
  QueueDisplayLinkStatusResponse,
  QueueStatsQueryDto,
  QueueStatsResponse,
  QueueTurnResponse,
  RegisterWalkInDto,
} from './queue.dto';

/** Marca de «usuario con permiso `.own` y sin ficha profesional»: no ve nada. */
const NO_STYLIST_PROFILE = '__sin_ficha_profesional__';

const has = (user: AccessTokenClaims, permission: string) =>
  user.permissions.includes(WILDCARD_PERMISSION) || user.permissions.includes(permission);

/**
 * Adaptador HTTP de la fila de espera (ADR-0024).
 *
 * Mismo reparto que las comandas: recepción trabaja con los permisos completos y la
 * profesional con `.own` —ve lo que puede atender, llama a la siguiente y atiende lo suyo—.
 * El controlador traduce el usuario a su ficha profesional y el caso de uso impone el
 * ámbito.
 */
@ApiTags('Fila de espera')
@Controller({ path: 'queue', version: '1' })
export class QueueController {
  private readonly currency: string;

  constructor(
    private readonly board: GetQueueBoardUseCase,
    private readonly registerWalkIn: RegisterWalkInUseCase,
    private readonly callNext: CallNextUseCase,
    private readonly callTurn: CallTurnUseCase,
    private readonly changeTurn: ChangeQueueTurnUseCase,
    private readonly finishTurn: FinishQueueTurnUseCase,
    private readonly issueDisplayLink: IssueQueueDisplayLinkUseCase,
    private readonly stats: GetQueueStatsUseCase,
    private readonly tickets: ListServiceTicketsUseCase,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(QUEUE_DISPLAY_LINKS) private readonly displayLinks: QueueDisplayLinks,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  /**
   * `null` con el permiso completo; si no, la ficha profesional de quien llama. Un usuario
   * `.own` sin ficha recibe un id imposible: no ve nada en lugar de verlo todo.
   */
  private async ownScopeFor(user: AccessTokenClaims, fullPermission: string) {
    if (has(user, fullPermission)) return null;
    const stylist = await this.stylists.findByUserId(user.sub);
    return stylist?.id ?? NO_STYLIST_PROFILE;
  }

  /** El turno con nombres y puesto, como lo pinta la fila. */
  private async present(turn: QueueTurn): Promise<QueueTurnResponse> {
    return QueueTurnResponse.from(await this.board.viewOf(turn));
  }

  @Get()
  @RequireAnyPermission(PERMISSIONS.queue.read, PERMISSIONS.queue.readOwn)
  @ApiOperation({
    operationId: 'queue_board',
    summary: 'La fila de hoy',
    description:
      'En espera, llamadas, en el sillón y las ya cerradas hoy. Con `queue.read.own`, solo ' +
      'las que esta profesional puede atender y las suyas.',
  })
  @ApiOkResponse({ type: QueueBoardResponse })
  async list(@CurrentUser() user: AccessTokenClaims): Promise<QueueBoardResponse> {
    const board = await this.board.execute({
      restrictToStylistId: await this.ownScopeFor(user, PERMISSIONS.queue.read),
    });
    return {
      businessDate: board.businessDate,
      turns: board.turns.map((view) => QueueTurnResponse.from(view)),
      averageWaitMinutes: board.averageWaitMinutes,
      waitSamples: board.waitSamples,
    };
  }

  @Get('stats')
  // Son cifras del negocio para decidir, como los informes: no hace falta ver la fila.
  @RequirePermissions(PERMISSIONS.reports.read)
  @ApiOperation({
    operationId: 'queue_stats',
    summary: 'Indicadores de la fila: espera, abandono, horas y días con más gente',
    description:
      'Por días del salón, ambos incluidos. Sin fechas, los últimos 30 días hasta hoy. ' +
      'Máximo un año.',
  })
  @ApiOkResponse({ type: QueueStatsResponse })
  async statistics(@Query() query: QueueStatsQueryDto): Promise<QueueStatsResponse> {
    return QueueStatsResponse.from(
      await this.stats.execute({ from: query.from ?? null, to: query.to ?? null }),
    );
  }

  @Post()
  @RequirePermissions(PERMISSIONS.queue.create)
  @ApiOperation({
    operationId: 'queue_register',
    summary: 'Anota en la fila a una clienta que llega sin cita',
  })
  @ApiCreatedResponse({ type: QueueTurnResponse })
  async register(
    @Body() dto: RegisterWalkInDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<QueueTurnResponse> {
    const turn = await this.registerWalkIn.execute({
      tenantId: requireTenant(user),
      clientId: dto.clientId ?? null,
      clientName: dto.clientName ?? null,
      serviceIds: dto.serviceIds ?? [],
      preferredStylistId: dto.preferredStylistId ?? null,
      notes: dto.notes ?? null,
      actorId: user.sub,
    });
    return this.present(turn);
  }

  @Post('next')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(PERMISSIONS.queue.attend, PERMISSIONS.queue.attendOwn)
  @ApiOperation({
    operationId: 'queue_call_next',
    summary: 'Llama a la siguiente de la fila que la profesional puede atender',
    description:
      'Por orden de llegada, saltando a quien pidió a otra profesional o un servicio que ' +
      'ella no hace. Devuelve `turn: null` si no queda nadie para ella.',
  })
  @ApiOkResponse({ type: CallNextResponse })
  async next(
    @Body() dto: CallNextDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CallNextResponse> {
    const turn = await this.callNext.execute({
      stylistId: await this.actingStylistId(user, dto.stylistId),
      actorId: user.sub,
    });
    return { turn: turn ? await this.present(turn) : null };
  }

  @Post(':id/call')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.queue.attend)
  @ApiOperation({
    operationId: 'queue_call',
    summary: 'Asigna un turno concreto a una profesional y la llama',
    description:
      'Para cuando la clienta acepta ir con otra profesional. Se salta la preferencia, ' +
      'nunca lo que la profesional sabe hacer.',
  })
  @ApiOkResponse({ type: QueueTurnResponse })
  async call(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CallTurnDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<QueueTurnResponse> {
    return this.present(
      await this.callTurn.execute({ turnId: id, stylistId: dto.stylistId, actorId: user.sub }),
    );
  }

  @Post(':id/recall')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(PERMISSIONS.queue.attend, PERMISSIONS.queue.attendOwn)
  @ApiOperation({ operationId: 'queue_recall', summary: 'Vuelve a anunciar a la clienta' })
  @ApiOkResponse({ type: QueueTurnResponse })
  recall(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.change(id, 'recall', user);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(PERMISSIONS.queue.attend, PERMISSIONS.queue.attendOwn)
  @ApiOperation({ operationId: 'queue_start', summary: 'La clienta ya está en el sillón' })
  @ApiOkResponse({ type: QueueTurnResponse })
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.change(id, 'start', user);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(PERMISSIONS.queue.attend, PERMISSIONS.queue.attendOwn)
  @ApiOperation({ operationId: 'queue_no_show', summary: 'La llamaron y no se presentó' })
  @ApiOkResponse({ type: QueueTurnResponse })
  noShow(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.change(id, 'no-show', user);
  }

  @Post(':id/requeue')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(PERMISSIONS.queue.attend, PERMISSIONS.queue.attendOwn)
  @ApiOperation({
    operationId: 'queue_requeue',
    summary: 'Devuelve a la fila, en su sitio, a una clienta llamada',
  })
  @ApiOkResponse({ type: QueueTurnResponse })
  requeue(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.change(id, 'requeue', user);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.queue.attend)
  @ApiOperation({
    operationId: 'queue_cancel',
    summary: 'Saca de la fila a una clienta que se fue o se anotó por error',
  })
  @ApiOkResponse({ type: QueueTurnResponse })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTurnDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.change(id, 'cancel', user, dto.reason);
  }

  @Post(':id/finish')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(PERMISSIONS.queue.attend, PERMISSIONS.queue.attendOwn)
  @ApiOperation({
    operationId: 'queue_finish',
    summary: 'Termina el turno y envía a caja lo que se le hizo',
    description:
      'Crea la comanda (ADR-0019) y cierra el turno en la misma transacción. Exige además ' +
      'poder registrar comandas: `service-tickets.create`, o `.own` para los turnos propios.',
  })
  @ApiOkResponse({ type: FinishTurnResponse })
  async finish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinishTurnDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<FinishTurnResponse> {
    const restrictToStylistId = await this.ownScopeFor(user, PERMISSIONS.queue.attend);
    // Terminar es registrar una comanda: no puede ser la puerta trasera para quien no puede.
    const canDeclare =
      has(user, PERMISSIONS.serviceTickets.create) ||
      (restrictToStylistId !== null && has(user, PERMISSIONS.serviceTickets.createOwn));
    if (!canDeclare) throw new ForbiddenActionError(PERMISSIONS.serviceTickets.create);

    const { turn, ticket } = await this.finishTurn.execute({
      tenantId: requireTenant(user),
      turnId: id,
      serviceIds: dto.serviceIds,
      notes: dto.notes ?? null,
      actorId: user.sub,
      restrictToStylistId,
    });
    const [view] = await this.tickets.describe([ticket], this.currency);
    return { turn: await this.present(turn), ticket: ServiceTicketResponse.from(view) };
  }

  @Get('display-link')
  @RequirePermissions(PERMISSIONS.queue.manageDisplay)
  @ApiOperation({
    operationId: 'queue_display_link_status',
    summary: 'Si el salón tiene una pantalla de turnos con enlace vigente',
  })
  @ApiOkResponse({ type: QueueDisplayLinkStatusResponse })
  async displayLinkStatus(
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<QueueDisplayLinkStatusResponse> {
    return { active: await this.displayLinks.isActive(requireTenant(user)) };
  }

  @Post('display-link')
  @RequirePermissions(PERMISSIONS.queue.manageDisplay)
  @ApiOperation({
    operationId: 'queue_display_link_issue',
    summary: 'Crea el enlace de la pantalla de turnos y retira el anterior',
  })
  @ApiCreatedResponse({ type: QueueDisplayLinkResponse })
  async issueLink(@CurrentUser() user: AccessTokenClaims): Promise<QueueDisplayLinkResponse> {
    return { token: await this.issueDisplayLink.execute({ tenantId: requireTenant(user) }) };
  }

  // ---------------------------------------------------------------------------

  private async change(
    id: string,
    action: QueueTurnAction,
    user: AccessTokenClaims,
    reason?: string,
  ): Promise<QueueTurnResponse> {
    const turn = await this.changeTurn.execute({
      turnId: id,
      action,
      reason: reason ?? null,
      actorId: user.sub,
      restrictToStylistId: await this.ownScopeFor(user, PERMISSIONS.queue.attend),
    });
    return this.present(turn);
  }

  /**
   * Profesional que queda libre. Con `queue.attend` puede indicarse cualquiera; si no se
   * indica, la ficha de quien llama. Con `.own`, siempre la propia, llegue lo que llegue.
   */
  private async actingStylistId(
    user: AccessTokenClaims,
    requested: string | undefined,
  ): Promise<string> {
    const scope = await this.ownScopeFor(user, PERMISSIONS.queue.attend);
    if (scope === NO_STYLIST_PROFILE) {
      throw new ForbiddenActionError(
        PERMISSIONS.queue.attendOwn,
        'Tu cuenta no tiene ficha profesional vinculada. Pide a la administración que la cree.',
      );
    }
    if (scope) return scope;
    if (requested) return requested;

    const own = await this.stylists.findByUserId(user.sub);
    if (!own) throw new DomainValidationError('Indique la profesional', 'stylistId');
    return own.id;
  }
}

const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError('queue', 'La fila de espera requiere estar asignado a un salón');
  }
  return user.tenantId;
};
