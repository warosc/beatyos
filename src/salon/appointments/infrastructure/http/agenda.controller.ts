import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { interval, map, merge, type Observable } from 'rxjs';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { BusinessRuleViolationError } from '../../../../shared/domain/errors';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../../stylists/domain/stylist.repository';
import {
  BlockStylistTimeUseCase,
  GetAgendaShiftsUseCase,
  RemoveStylistBlockUseCase,
} from '../../application/appointment.use-cases';
import {
  ApproveChangeRequestUseCase,
  ListChangeRequestsUseCase,
  RejectChangeRequestUseCase,
  WithdrawChangeRequestUseCase,
} from '../../application/change-request.use-cases';
import { SendDueRemindersUseCase } from '../../application/reminder.use-cases';
import {
  AGENDA_DIRECTORY,
  REMINDER_SENDER,
  REMINDER_SETTINGS,
  type AgendaDirectory,
  type ReminderSender,
  type ReminderSettings,
} from '../../domain/agenda.ports';
import type { AppointmentChangeRequest } from '../../domain/change-request.entity';
import {
  CHANGE_REQUEST_REPOSITORY,
  type ChangeRequestRepository,
} from '../../domain/change-request.repository';
import { InMemoryAgendaEvents } from '../realtime/in-memory-agenda-events';
import {
  BlockTimeDto,
  ChangeRequestQueryDto,
  ChangeRequestResponse,
  DecideChangeDto,
  ReminderRunResponse,
  ReminderSettingsResponse,
  ShiftsQueryDto,
  StylistShiftsResponse,
} from './agenda.dto';
import { hasPermission } from './appointments.controller';

/** Cada cuánto llega un latido por el canal en vivo: mantiene viva la conexión en proxies. */
const HEARTBEAT_MS = 25_000;

/**
 * Lo que rodea a las citas: la jornada que se pinta de fondo, los bloqueos, los cambios
 * que piden las profesionales, los recordatorios y el canal de avisos en vivo.
 *
 * Va en su propio prefijo (`/agenda`) y no bajo `/appointments` para no competir con la
 * ruta `/appointments/:id`.
 */
@ApiTags('Agenda')
@Controller({ path: 'agenda', version: '1' })
export class AgendaController {
  constructor(
    private readonly shifts: GetAgendaShiftsUseCase,
    private readonly blockTime: BlockStylistTimeUseCase,
    private readonly removeBlock: RemoveStylistBlockUseCase,
    private readonly listRequests: ListChangeRequestsUseCase,
    private readonly approveRequest: ApproveChangeRequestUseCase,
    private readonly rejectRequest: RejectChangeRequestUseCase,
    private readonly withdrawRequest: WithdrawChangeRequestUseCase,
    private readonly sendDueReminders: SendDueRemindersUseCase,
    private readonly events: InMemoryAgendaEvents,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    @Inject(AGENDA_DIRECTORY) private readonly directory: AgendaDirectory,
    @Inject(CHANGE_REQUEST_REPOSITORY) private readonly requests: ChangeRequestRepository,
    @Inject(REMINDER_SETTINGS) private readonly reminderSettings: ReminderSettings,
    @Inject(REMINDER_SENDER) private readonly reminderSender: ReminderSender,
  ) {}

  /** Ficha propia de quien solo ve su agenda; `null` si ve la de todo el salón. */
  private async ownStylistId(user: AccessTokenClaims): Promise<string | null> {
    if (hasPermission(user, PERMISSIONS.appointments.read)) return null;
    const stylist = await this.stylists.findByUserId(user.sub);
    return stylist?.id ?? '__sin_ficha_profesional__';
  }

  private async presentRequests(
    requests: readonly AppointmentChangeRequest[],
  ): Promise<ChangeRequestResponse[]> {
    const summaries = await this.directory.summarize(requests.map((r) => r.appointmentId));
    return requests.map((r) => ChangeRequestResponse.from(r, summaries.get(r.appointmentId)));
  }

  // -- Jornada y bloqueos -------------------------------------------------------

  @Get('shifts')
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({
    summary: 'Jornada y bloqueos por profesional',
    description:
      'Lo que la parrilla pinta de fondo: la jornada de cada profesional ya descontadas sus ' +
      'ausencias, y los bloqueos del rango. Con ámbito propio, solo la ficha de quien consulta.',
  })
  @ApiOkResponse({ type: [StylistShiftsResponse] })
  async getShifts(
    @Query() query: ShiftsQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<StylistShiftsResponse[]> {
    const shifts = await this.shifts.execute({
      from: query.from,
      to: query.to,
      stylistIds: query.stylistIds,
      restrictToStylistId: await this.ownStylistId(user),
    });
    return shifts.map((entry) => StylistShiftsResponse.from(entry));
  }

  @Post('blocks')
  @RequirePermissions(PERMISSIONS.stylists.manageSchedule)
  @ApiOperation({
    summary: 'Bloquear un tramo de agenda',
    description:
      'Comida, formación, un recado. No se permite tapar citas ya reservadas: primero se ' +
      'mueven, después se bloquea.',
  })
  @ApiCreatedResponse({ schema: { properties: { id: { type: 'string' } } } })
  @ApiConflictResponse({ description: 'Hay citas en ese tramo' })
  addBlock(
    @Body() dto: BlockTimeDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ id: string }> {
    return this.blockTime.execute({
      stylistId: dto.stylistId,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      reason: dto.reason,
      actorId: user.sub,
    });
  }

  @Delete('blocks/:stylistId/:blockId')
  @RequirePermissions(PERMISSIONS.stylists.manageSchedule)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar un bloqueo de agenda' })
  @ApiParam({ name: 'stylistId', format: 'uuid' })
  @ApiNoContentResponse()
  async deleteBlock(
    @Param('stylistId', ParseUUIDPipe) stylistId: string,
    @Param('blockId') blockId: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.removeBlock.execute({ stylistId, blockId, actorId: user.sub });
  }

  // -- Solicitudes de cambio ----------------------------------------------------

  @Get('change-requests')
  @RequireAnyPermission(PERMISSIONS.appointments.approveChanges, PERMISSIONS.appointments.updateOwn)
  @ApiOperation({
    summary: 'Cambios de hora pedidos por las profesionales',
    description:
      'Quien aprueba ve los de todo el equipo; la profesional, solo los suyos —con la ' +
      'respuesta que recibió—.',
  })
  @ApiOkResponse({ type: [ChangeRequestResponse] })
  async changeRequests(
    @Query() query: ChangeRequestQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ChangeRequestResponse[]> {
    const approver = hasPermission(user, PERMISSIONS.appointments.approveChanges);
    const own = approver
      ? null
      : ((await this.stylists.findByUserId(user.sub))?.id ?? '__sin_ficha_profesional__');
    const requests = await this.listRequests.execute({
      status: query.status,
      decidedSince: query.decidedSince,
      limit: query.limit,
      restrictToStylistId: own,
    });
    return this.presentRequests(requests);
  }

  @Get('change-requests/pending-count')
  @RequirePermissions(PERMISSIONS.appointments.approveChanges)
  @ApiOperation({ summary: 'Cuántos cambios esperan respuesta. Alimenta el aviso del menú.' })
  @ApiOkResponse({ schema: { properties: { count: { type: 'number' } } } })
  async pendingCount(): Promise<{ count: number }> {
    return { count: await this.requests.countPending() };
  }

  @Patch('change-requests/:id/approve')
  @RequirePermissions(PERMISSIONS.appointments.approveChanges)
  @ApiOperation({
    summary: 'Aprobar un cambio y mover la cita',
    description:
      'Mueve la cita con las mismas comprobaciones que recepción. Si la hora ya no cabe, ' +
      'falla y la solicitud sigue pendiente.',
  })
  @ApiOkResponse({ type: ChangeRequestResponse })
  @ApiConflictResponse({ description: 'La hora propuesta ya no está libre' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideChangeDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ChangeRequestResponse> {
    const request = await this.approveRequest.execute({ id, actorId: user.sub, note: dto.note });
    return (await this.presentRequests([request]))[0];
  }

  @Patch('change-requests/:id/reject')
  @RequirePermissions(PERMISSIONS.appointments.approveChanges)
  @ApiOperation({ summary: 'Rechazar un cambio. La cita se queda como estaba.' })
  @ApiOkResponse({ type: ChangeRequestResponse })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideChangeDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ChangeRequestResponse> {
    const request = await this.rejectRequest.execute({ id, actorId: user.sub, note: dto.note });
    return (await this.presentRequests([request]))[0];
  }

  @Patch('change-requests/:id/withdraw')
  @RequirePermissions(PERMISSIONS.appointments.updateOwn)
  @ApiOperation({ summary: 'Retirar un cambio que pidió una misma' })
  @ApiOkResponse({ type: ChangeRequestResponse })
  async withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ChangeRequestResponse> {
    const stylist = await this.stylists.findByUserId(user.sub);
    if (!stylist) {
      throw new BusinessRuleViolationError(
        'STYLIST_PROFILE_REQUIRED',
        'Tu cuenta no tiene una ficha de profesional vinculada',
      );
    }
    const request = await this.withdrawRequest.execute({
      id,
      actorId: user.sub,
      stylistId: stylist.id,
    });
    return (await this.presentRequests([request]))[0];
  }

  // -- Recordatorios ------------------------------------------------------------

  @Get('reminders/settings')
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({ summary: 'Cómo salen los recordatorios automáticos' })
  @ApiOkResponse({ type: ReminderSettingsResponse })
  reminderSettingsInfo(): ReminderSettingsResponse {
    return {
      enabled: this.reminderSettings.enabled,
      channel: this.reminderSender.channel,
      leadHours: this.reminderSettings.leadHours,
    };
  }

  @Post('reminders/run')
  @RequirePermissions(PERMISSIONS.appointments.update)
  @ApiOperation({
    summary: 'Enviar ahora los recordatorios pendientes del salón',
    description:
      'Lo mismo que hace el planificador cada cinco minutos, a demanda. Una cita ya ' +
      'recordada no se recuerda dos veces.',
  })
  @ApiCreatedResponse({ type: ReminderRunResponse })
  runReminders(@CurrentUser() user: AccessTokenClaims): Promise<ReminderRunResponse> {
    return this.sendDueReminders.execute({ actorId: user.sub });
  }

  // -- Avisos en vivo -----------------------------------------------------------

  /**
   * Canal de avisos (Server-Sent Events).
   *
   * Solo dice **qué** cambió, nunca los datos: la interfaz vuelve a pedir la agenda por la
   * vía normal, que aplica los permisos. A quien solo ve su agenda se le dice además si el
   * cambio es suyo, sin revelar de quién es si no lo es.
   */
  @Sse('stream')
  @RequireAnyPermission(PERMISSIONS.appointments.read, PERMISSIONS.appointments.readOwn)
  @ApiOperation({ summary: 'Avisos en vivo de cambios en la agenda (text/event-stream)' })
  async stream(@CurrentUser() user: AccessTokenClaims): Promise<Observable<MessageEvent>> {
    const own = await this.ownStylistId(user);
    const changes = this.events.forTenant(user.tenantId!).pipe(
      map((event): MessageEvent => ({
        data: {
          kind: event.kind,
          status: event.status ?? null,
          mine: own ? event.stylistIds.includes(own) : null,
          stylistIds: own ? [] : event.stylistIds,
          at: event.at.toISOString(),
        },
      })),
    );
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ data: { kind: 'ping', at: new Date().toISOString() } })),
    );
    return merge(changes, heartbeat);
  }
}
